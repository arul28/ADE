import { type CallerTokenEnv } from "../callerToken";
import { fail } from "../cloud/http";
import { type CloudEmailEnv } from "../cloud/email";
import { boundedDisplayText } from "../displayText";
import { logLaneShare } from "../logging";
import { readBoundedBody, sha256Hex, utcDayKey } from "../sinkUtils";
import {
  clerkAccount,
  normalizeEmail,
  type ClerkAccount,
  type ClerkAccountEnv,
} from "./clerkAccount";
import {
  LANE_SHARE_HOURLY_CLERK_READS_PER_USER,
  LANE_SHARE_MAX_DURATION_MS,
  LANE_SHARE_GRANT_ID_PATTERN as GRANT_ID,
  LANE_SHARE_PATHS,
  LANE_SHARE_PRESETS,
  LANE_SHARE_RISKS,
  laneShareInviteLink,
  type LaneShareClosedReason,
  type LaneShareGiverView,
  type LaneSharePreset,
  type LaneShareReceiverView,
  type LaneShareRisk,
  type LaneShareState,
} from "./contract";

/**
 * The grant rows of lane sharing and what every route reads from them:
 * the row shape, the views, the request parsers and the daily budgets.
 * The routes are in `routes.ts`, `invites.ts` and `tickets.ts`.
 */

export type LaneShareEnv = CallerTokenEnv & ClerkAccountEnv & CloudEmailEnv & {
  DB: D1Database;
  WEB_CLIENT_ORIGIN?: string;
};

export const PREFIX = LANE_SHARE_PATHS.root;
const MAX_BODY_BYTES = 16 * 1024;
const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MACHINE_KEY = /^[\x21-\x7e]{1,128}$/;
/** `accountRepoScopeKey`'s output: lowercase host (optional port), then a path, no credential, no query. */
const REPO_KEY = /^repo:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?\/[^\s?#@\\]+$/;
const MAX_REPO_KEY = 300;
const MAX_EMAIL = 254;
const EMAIL = /^[^\s@<>()",;:\\[\]]{1,64}@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
const MAX_LABEL = 120;
export const MAX_GIVER_LABEL = 80;
export const LIST_LIMIT = 200;
export const HOST_LIMIT = 1000;
/** At most this many verified addresses go into one `in (...)` read. */
export const MAX_EMAILS_PER_LOOKUP = 10;
export const LIVE_STATES = "('pending', 'active')";

export const COLUMNS = `id, giver_user_id, receiver_user_id, receiver_email, repo_key, machine_key, lane_id,
  giver_label, project_label, lane_label, preset, risk, state, closed_reason, invite_expires_at, ends_at,
  version, invite_email_count, last_invite_email_at, created_at, updated_at, accepted_at, closed_at, receiver_label`;

export type ShareRow = {
  id: string;
  giver_user_id: string;
  receiver_user_id: string | null;
  receiver_email: string;
  repo_key: string;
  machine_key: string;
  lane_id: string;
  giver_label: string | null;
  project_label: string | null;
  lane_label: string | null;
  preset: LaneSharePreset;
  risk: LaneShareRisk;
  state: LaneShareState;
  closed_reason: string | null;
  invite_expires_at: number;
  ends_at: number | null;
  version: number;
  invite_email_count: number;
  last_invite_email_at: number | null;
  created_at: number;
  updated_at: number;
  accepted_at: number | null;
  closed_at: number | null;
  receiver_label: string | null;
};

const NOT_FOUND_MESSAGE = "That lane share was not found. If it was sent to you, sign in with the email address it went to.";
export const notFound = () => fail("not_found", NOT_FOUND_MESSAGE, 404);
export const badRequest = (message: string) => fail("bad_request", message, 400);
export const clerkUnavailable = () => fail("unavailable", "ADE can't check your email address right now. Try again soon.", 503);
export const shareClosed = () => fail("share_closed", "This lane share has ended.", 410);
export const clerkBudgetSpent = () => fail("rate_limited", "Too many lane share requests from this account. Try again later.", 429);

/**
 * The state a reader sees. `ends_at` passed wins (`ended`); otherwise a
 * pending invite past its 24 h reads `expired`. Server epoch ms only.
 */
export function effectiveState(row: Pick<ShareRow, "state" | "ends_at" | "invite_expires_at">, now: number): LaneShareState {
  if (row.state !== "pending" && row.state !== "active") return row.state;
  if (row.ends_at != null && now >= row.ends_at) return "ended";
  if (row.state === "pending" && now >= row.invite_expires_at) return "expired";
  return row.state;
}

/** When a lazily closed row closed, so a view says the same before and after the row is settled. */
export function effectiveClosedAt(row: ShareRow, now: number): number | null {
  const state = effectiveState(row, now);
  if (state === row.state) return row.closed_at;
  return state === "ended" ? row.ends_at : row.invite_expires_at;
}

const closedReason = (row: ShareRow): LaneShareClosedReason => (row.closed_reason === "account_deleted" ? "account_deleted" : null);

function commonView(row: ShareRow, now: number) {
  return {
    id: row.id,
    state: effectiveState(row, now),
    repoKey: row.repo_key,
    laneId: row.lane_id,
    projectLabel: row.project_label,
    laneLabel: row.lane_label,
    preset: row.preset,
    risk: row.risk,
    inviteExpiresAt: row.invite_expires_at,
    endsAt: row.ends_at,
    version: row.version,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    closedAt: effectiveClosedAt(row, now),
    closedReason: closedReason(row),
  };
}

export function giverView(row: ShareRow, now: number): LaneShareGiverView {
  return {
    ...commonView(row, now),
    receiverEmail: row.receiver_email,
    receiverUserId: row.receiver_user_id,
    machineKey: row.machine_key,
    updatedAt: row.updated_at,
    link: laneShareInviteLink(row.id),
  };
}

export function receiverView(row: ShareRow, now: number): LaneShareReceiverView {
  return {
    ...commonView(row, now),
    giverUserId: row.giver_user_id,
    giverLabel: row.giver_label,
    receiverEmail: row.receiver_email,
  };
}

export async function loadRow(env: LaneShareEnv, id: string): Promise<ShareRow | null> {
  if (!GRANT_ID.test(id)) return null;
  return env.DB.prepare(`select ${COLUMNS} from lane_shares where id = ?`).bind(id).first<ShareRow>();
}

/** A row this call just wrote. It exists: rows are only deleted by the cron, long after they close. */
export async function reload(env: LaneShareEnv, id: string): Promise<ShareRow> {
  const row = await loadRow(env, id);
  if (!row) throw new Error("lane_share_row_missing");
  return row;
}

/**
 * Writes the clock-derived states of one lane, so the stored state equals
 * the derived one for the writes that follow (the guest count and the two
 * partial unique indexes read the stored state).
 */
export async function settleLane(env: LaneShareEnv, giverUserId: string, laneId: string, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`
      update lane_shares set state = 'ended', closed_at = ends_at, updated_at = ?, version = version + 1
      where giver_user_id = ? and lane_id = ? and state in ${LIVE_STATES} and ends_at is not null and ends_at <= ?
    `).bind(now, giverUserId, laneId, now),
    env.DB.prepare(`
      update lane_shares set state = 'expired', closed_at = invite_expires_at, updated_at = ?, version = version + 1
      where giver_user_id = ? and lane_id = ? and state = 'pending' and invite_expires_at <= ?
    `).bind(now, giverUserId, laneId, now),
  ]);
}

export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

export function newGrantId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ls_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function ownsMachine(env: LaneShareEnv, userId: string, machineKey: string): Promise<boolean> {
  const row = await env.DB.prepare("select 1 as found from machines where user_id = ? and machine_key = ?")
    .bind(userId, machineKey).first<{ found: number }>();
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Input

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  let read: Awaited<ReturnType<typeof readBoundedBody>>;
  try {
    read = await readBoundedBody(request, MAX_BODY_BYTES);
  } catch {
    return null;
  }
  if (!read.ok) return null;
  if (!read.text) return {};
  try {
    const value = JSON.parse(read.text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = normalizeEmail(value);
  if (email.length > MAX_EMAIL || /[\p{Cc}\p{Cf}]/u.test(email) || !EMAIL.test(email)) return null;
  return email;
}

export function parseRepoKey(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_REPO_KEY || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  return REPO_KEY.test(value) ? value : null;
}

export const parseLaneId = (value: unknown): string | null => (typeof value === "string" && LANE_ID.test(value) ? value : null);
export const parseMachineKey = (value: unknown): string | null => (typeof value === "string" && MACHINE_KEY.test(value) ? value : null);
export const parsePreset = (value: unknown): LaneSharePreset | null =>
  (LANE_SHARE_PRESETS as readonly unknown[]).includes(value) ? value as LaneSharePreset : null;
export const parseRisk = (value: unknown): LaneShareRisk | null =>
  (LANE_SHARE_RISKS as readonly unknown[]).includes(value) ? value as LaneShareRisk : null;

/** `undefined` = not given; `null` = no end; a number = epoch ms. `false` = invalid. */
export function parseEndsAt(value: unknown, now: number): number | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  if (value <= now || value > now + LANE_SHARE_MAX_DURATION_MS) return false;
  return value;
}

/** An optional label: absent or null is null; anything else is cleaned display text. Wrong types are invalid. */
export function parseLabel(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 4 * MAX_LABEL) return false;
  return boundedDisplayText(value, MAX_LABEL);
}

// ---------------------------------------------------------------------------
// Invite budget

export async function claimDay(env: LaneShareEnv, day: string, subject: string, cap: number): Promise<boolean> {
  const result = await env.DB.prepare(`
    insert into lane_share_invite_days (day, subject, count) values (?, ?, 1)
    on conflict(day, subject) do update set count = count + 1 where count < ?
  `).bind(day, subject, cap).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function refundDay(env: LaneShareEnv, day: string, subject: string): Promise<void> {
  try {
    await env.DB.prepare("update lane_share_invite_days set count = count - 1 where day = ? and subject = ? and count > 0")
      .bind(day, subject).run();
  } catch {
    // One slot lost for the day is the safe direction.
  }
}

export const giverSubject = (userId: string) => `giver:${userId}`;
/** Every invite email of the day, from all accounts together. */
export const GLOBAL_EMAIL_SUBJECT = "all";

/**
 * The address the per-recipient cap counts, so `a.b+x@gmail.com` and
 * `ab@gmail.com` share one budget: lowercase, no `+tag`, and no dots in the
 * local part at Gmail (which ignores them). Only the cap uses it: the invite
 * keeps and matches the exact address.
 */
function canonicalCapAddress(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at <= 0) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

export const recipientSubject = async (email: string) => `to:${(await sha256Hex(canonicalCapAddress(email))).slice(0, 32)}`;

/** One account's Clerk reads in one UTC hour, kept in the day's budget table. */
const clerkSubject = (userId: string, now: number) => `clerk:${new Date(now).toISOString().slice(11, 13)}:${userId}`;

/**
 * `clerkAccount` behind a per-account hourly budget, so one account cannot
 * spend the Worker's Clerk Backend API allowance. `"over_budget"` when the
 * budget is spent (the caller answers 429), null when Clerk could not be
 * asked. The claim does not depend on the row, so a 429 says nothing about
 * whether an id exists.
 */
export async function budgetedClerkAccount(
  env: LaneShareEnv,
  userId: string,
  now: number,
  /** Whose account to read; the caller's by default. The read counts against the caller. */
  accountUserId: string = userId,
): Promise<ClerkAccount | null | "over_budget"> {
  if (!env.CLERK_SECRET_KEY?.trim()) return null;
  if (!(await claimDay(env, utcDayKey(now), clerkSubject(userId, now), LANE_SHARE_HOURLY_CLERK_READS_PER_USER))) {
    logLaneShare({ event: "lane_share.refused", userId, code: "clerk_budget" });
    return "over_budget";
  }
  return clerkAccount(env, accountUserId);
}
