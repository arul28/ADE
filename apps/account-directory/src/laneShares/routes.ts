import { authenticate, type CallerTokenEnv } from "../callerToken";
import { UNREADABLE_REQUEST_MESSAGE, fail, json } from "../cloud/http";
import { sendLaneShareInviteEmail, type CloudEmailEnv } from "../cloud/email";
import { boundedDisplayText } from "../displayText";
import { logLaneShare } from "../logging";
import { readBoundedBody, sha256Hex, utcDayKey } from "../sinkUtils";
import { trustedHttpsOrigin } from "../trustedOrigin";
import { clerkAccount, normalizeEmail, type ClerkAccount, type ClerkAccountEnv } from "./clerkAccount";
import {
  LANE_SHARE_CLOSED_VISIBLE_MS,
  LANE_SHARE_DAILY_EMAILS_PER_RECIPIENT,
  LANE_SHARE_DAILY_INVITES_PER_GIVER,
  LANE_SHARE_HOST_CLOSED_WINDOW_MS,
  LANE_SHARE_INVITE_TTL_MS,
  LANE_SHARE_MAX_DURATION_MS,
  LANE_SHARE_MAX_EMAILS_PER_INVITE,
  LANE_SHARE_MAX_GUESTS_PER_LANE,
  LANE_SHARE_PATHS,
  LANE_SHARE_PRESETS,
  LANE_SHARE_RESEND_INTERVAL_MS,
  LANE_SHARE_RISKS,
  laneShareInviteLink,
  type LaneShareClosedReason,
  type LaneShareEmailNotSentReason,
  type LaneShareGiverView,
  type LaneShareHostResponse,
  type LaneShareInviteResponse,
  type LaneShareOpenResponse,
  type LaneSharePreset,
  type LaneShareReceivedResponse,
  type LaneShareReceiverView,
  type LaneShareRisk,
  type LaneShareState,
} from "./contract";

/**
 * Lane sharing: the account-level record of grants (README, "Lane sharing";
 * table in migration 0019; shapes in `contract.ts`).
 *
 * Default refuse. Every route reads the row and compares the caller's user id
 * with it; a pending invite is matched against the addresses Clerk has
 * VERIFIED for the caller, read fresh on each call (`clerkAccount`). A caller
 * who may not see a grant gets the same 404 as an id that does not exist, and
 * the routes that may need Clerk ask it before deciding that 404, so whether
 * Clerk is reachable says nothing about whether an id exists.
 *
 * This Worker never opens a machine. The host machine keeps the rights and
 * asks `POST /lane-shares/host` on every guest connection; that read goes to
 * D1 with no cache, so a revoke is visible to the next connection at once.
 */

export type LaneShareEnv = CallerTokenEnv & ClerkAccountEnv & CloudEmailEnv & {
  DB: D1Database;
  WEB_CLIENT_ORIGIN?: string;
};

const PREFIX = LANE_SHARE_PATHS.root;
const MAX_BODY_BYTES = 16 * 1024;
const GRANT_ID = /^ls_[0-9a-f]{32}$/;
const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MACHINE_KEY = /^[\x21-\x7e]{1,128}$/;
/** `accountRepoScopeKey`'s output: lowercase host (optional port), then a path, no credential, no query. */
const REPO_KEY = /^repo:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?\/[^\s?#@\\]+$/;
const MAX_REPO_KEY = 300;
const MAX_EMAIL = 254;
const EMAIL = /^[^\s@<>()",;:\\[\]]{1,64}@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
const MAX_LABEL = 120;
const MAX_GIVER_LABEL = 80;
const LIST_LIMIT = 200;
const HOST_LIMIT = 1000;
/** At most this many verified addresses go into one `in (...)` read. */
const MAX_EMAILS_PER_LOOKUP = 10;
const LIVE_STATES = "('pending', 'active')";

const COLUMNS = `id, giver_user_id, receiver_user_id, receiver_email, repo_key, machine_key, lane_id,
  giver_label, project_label, lane_label, preset, risk, state, closed_reason, invite_expires_at, ends_at,
  version, invite_email_count, last_invite_email_at, created_at, updated_at, accepted_at, closed_at`;

type ShareRow = {
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
};

const NOT_FOUND_MESSAGE = "That lane share was not found. If it was sent to you, sign in with the email address it went to.";
const notFound = () => fail("not_found", NOT_FOUND_MESSAGE, 404);
const badRequest = (message: string) => fail("bad_request", message, 400);
const clerkUnavailable = () => fail("unavailable", "ADE can't check your email address right now. Try again soon.", 503);
const shareClosed = () => fail("share_closed", "This lane share has ended.", 410);

export function isLaneShareRequest(url: URL): boolean {
  return url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`);
}

// ---------------------------------------------------------------------------
// Routing and CORS

type Route =
  | { kind: "invite" }
  | { kind: "given" }
  | { kind: "received" }
  | { kind: "host" }
  | { kind: "grant"; id: string }
  | { kind: "action"; id: string; action: "accept" | "revoke" | "leave" | "move" };

const ACTIONS = new Set(["accept", "revoke", "leave", "move"]);

function matchRoute(path: string): Route | null {
  if (path === PREFIX) return { kind: "invite" };
  if (path === LANE_SHARE_PATHS.given) return { kind: "given" };
  if (path === LANE_SHARE_PATHS.received) return { kind: "received" };
  if (path === LANE_SHARE_PATHS.host) return { kind: "host" };
  const [id, action, ...rest] = path.slice(PREFIX.length + 1).split("/");
  if (!id || rest.length) return null;
  if (action === undefined) return { kind: "grant", id };
  return ACTIONS.has(action) ? { kind: "action", id, action: action as "accept" | "revoke" | "leave" | "move" } : null;
}

function methodsFor(route: Route): string[] {
  switch (route.kind) {
    case "given":
    case "received":
      return ["GET"];
    case "grant":
      return ["GET", "PATCH"];
    default:
      return ["POST"];
  }
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const ALLOWED_REQUEST_HEADERS = new Set(["authorization", "content-type", "x-ade-correlation-id"]);

/**
 * CORS is the directory's rule (`handleRequest`): only the hosted web client's
 * exact origin, never `*`, and a native caller sends no Origin. The host read
 * is for machines only, so no browser origin may call it. A refused origin is
 * answered before the token or D1 is touched.
 */
export async function handleLaneShareRequest(request: Request, env: LaneShareEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const route = matchRoute(path);
  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = trustedHttpsOrigin(env.WEB_CLIENT_ORIGIN, { requireExactOrigin: true });
  const corsOrigin = route && route.kind !== "host" && requestOrigin && allowedOrigin && requestOrigin === allowedOrigin
    ? allowedOrigin
    : null;

  if (request.method === "OPTIONS") {
    if (!route) return notFound();
    if (!corsOrigin) return fail("origin_not_allowed", "This origin can't call ADE lane sharing.", 403);
    const methods = methodsFor(route);
    const wanted = request.headers.get("access-control-request-method")?.toUpperCase() ?? "";
    if (!methods.includes(wanted)) return fail("bad_request", "That method isn't allowed here.", 405);
    const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
      .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
    if (requestedHeaders.some((header) => !ALLOWED_REQUEST_HEADERS.has(header))) {
      return fail("origin_not_allowed", "Those headers aren't allowed.", 403);
    }
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-headers": "authorization, content-type, x-ade-correlation-id",
        "access-control-allow-methods": `${methods.join(", ")}, OPTIONS`,
        "access-control-max-age": "600",
        vary: "Origin",
      },
    });
  }
  if (requestOrigin && !corsOrigin) return fail("origin_not_allowed", "This origin can't call ADE lane sharing.", 403);

  const response = await routeRequest(request, env, route);
  return corsOrigin ? withCors(response, corsOrigin) : response;
}

async function routeRequest(request: Request, env: LaneShareEnv, route: Route | null): Promise<Response> {
  if (!route || !methodsFor(route).includes(request.method)) return notFound();
  const caller = await authenticate(request, env);
  if (!caller.ok) {
    return caller.reason === "authentication unavailable"
      ? fail("unavailable", "ADE can't check your sign-in right now. Try again soon.", 503)
      : fail("unauthorized", "Sign in to ADE to share lanes.", 401);
  }
  const userId = caller.userId;
  const now = Date.now();
  switch (route.kind) {
    case "invite":
      return handleInvite(request, env, userId, now);
    case "given":
      return handleGiven(env, userId, now);
    case "received":
      return handleReceived(env, userId, now);
    case "host":
      return handleHostRead(request, env, userId, now);
    case "grant":
      return request.method === "GET" ? handleOpen(env, userId, route.id, now) : handleEdit(request, env, userId, route.id, now);
    case "action":
      if (route.action === "accept") return handleAccept(env, userId, route.id, now);
      if (route.action === "revoke") return handleRevoke(env, userId, route.id, now);
      if (route.action === "leave") return handleLeave(env, userId, route.id, now);
      return handleMove(request, env, userId, route.id, now);
  }
}

// ---------------------------------------------------------------------------
// Rows, state and views

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
function effectiveClosedAt(row: ShareRow, now: number): number | null {
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

function giverView(row: ShareRow, now: number): LaneShareGiverView {
  return {
    ...commonView(row, now),
    receiverEmail: row.receiver_email,
    receiverUserId: row.receiver_user_id,
    machineKey: row.machine_key,
    updatedAt: row.updated_at,
    link: laneShareInviteLink(row.id),
  };
}

function receiverView(row: ShareRow, now: number): LaneShareReceiverView {
  return {
    ...commonView(row, now),
    giverUserId: row.giver_user_id,
    giverLabel: row.giver_label,
    receiverEmail: row.receiver_email,
  };
}

async function loadRow(env: LaneShareEnv, id: string): Promise<ShareRow | null> {
  if (!GRANT_ID.test(id)) return null;
  return env.DB.prepare(`select ${COLUMNS} from lane_shares where id = ?`).bind(id).first<ShareRow>();
}

/** A row this call just wrote. It exists: rows are only deleted by the cron, long after they close. */
async function reload(env: LaneShareEnv, id: string): Promise<ShareRow> {
  const row = await loadRow(env, id);
  if (!row) throw new Error("lane_share_row_missing");
  return row;
}

/**
 * Writes the clock-derived states of one lane, so the stored state equals
 * the derived one for the writes that follow (the guest count and the two
 * partial unique indexes read the stored state).
 */
async function settleLane(env: LaneShareEnv, giverUserId: string, laneId: string, now: number): Promise<void> {
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

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

function newGrantId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ls_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function ownsMachine(env: LaneShareEnv, userId: string, machineKey: string): Promise<boolean> {
  const row = await env.DB.prepare("select 1 as found from machines where user_id = ? and machine_key = ?")
    .bind(userId, machineKey).first<{ found: number }>();
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Input

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
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

function parseEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = normalizeEmail(value);
  if (email.length > MAX_EMAIL || /[\p{Cc}\p{Cf}]/u.test(email) || !EMAIL.test(email)) return null;
  return email;
}

function parseRepoKey(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_REPO_KEY || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  return REPO_KEY.test(value) ? value : null;
}

const parseLaneId = (value: unknown): string | null => (typeof value === "string" && LANE_ID.test(value) ? value : null);
const parseMachineKey = (value: unknown): string | null => (typeof value === "string" && MACHINE_KEY.test(value) ? value : null);
const parsePreset = (value: unknown): LaneSharePreset | null =>
  (LANE_SHARE_PRESETS as readonly unknown[]).includes(value) ? value as LaneSharePreset : null;
const parseRisk = (value: unknown): LaneShareRisk | null =>
  (LANE_SHARE_RISKS as readonly unknown[]).includes(value) ? value as LaneShareRisk : null;

/** `undefined` = not given; `null` = no end; a number = epoch ms. `false` = invalid. */
function parseEndsAt(value: unknown, now: number): number | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  if (value <= now || value > now + LANE_SHARE_MAX_DURATION_MS) return false;
  return value;
}

/** An optional label: absent or null is null; anything else is cleaned display text. Wrong types are invalid. */
function parseLabel(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 4 * MAX_LABEL) return false;
  return boundedDisplayText(value, MAX_LABEL);
}

// ---------------------------------------------------------------------------
// Invite budget

async function claimDay(env: LaneShareEnv, day: string, subject: string, cap: number): Promise<boolean> {
  const result = await env.DB.prepare(`
    insert into lane_share_invite_days (day, subject, count) values (?, ?, 1)
    on conflict(day, subject) do update set count = count + 1 where count < ?
  `).bind(day, subject, cap).run();
  return (result.meta?.changes ?? 0) === 1;
}

async function refundDay(env: LaneShareEnv, day: string, subject: string): Promise<void> {
  try {
    await env.DB.prepare("update lane_share_invite_days set count = count - 1 where day = ? and subject = ? and count > 0")
      .bind(day, subject).run();
  } catch {
    // One slot lost for the day is the safe direction.
  }
}

const giverSubject = (userId: string) => `giver:${userId}`;
const recipientSubject = async (email: string) => `to:${(await sha256Hex(email)).slice(0, 32)}`;

/**
 * Sends the invite email when every limit allows it. `giverClaimed` is true
 * when the caller already took this invite's slot of the giver's daily budget
 * (a new invite); a re-send takes its own.
 */
async function deliverInvite(
  env: LaneShareEnv,
  row: ShareRow,
  now: number,
  giverClaimed: boolean,
): Promise<{ sent: boolean; reason: LaneShareEmailNotSentReason | null }> {
  // No sender: nothing is claimed, and the invite works by its link.
  if (!env.RESEND_API_KEY?.trim()) return { sent: false, reason: "not_configured" };
  const day = utcDayKey(now);
  const toSubject = await recipientSubject(row.receiver_email);
  if (!giverClaimed && !(await claimDay(env, day, giverSubject(row.giver_user_id), LANE_SHARE_DAILY_INVITES_PER_GIVER))) {
    return { sent: false, reason: "rate_limited" };
  }
  const giveBackGiver = async () => {
    if (!giverClaimed) await refundDay(env, day, giverSubject(row.giver_user_id));
  };
  if (!(await claimDay(env, day, toSubject, LANE_SHARE_DAILY_EMAILS_PER_RECIPIENT))) {
    await giveBackGiver();
    return { sent: false, reason: "rate_limited" };
  }
  // One write claims this invite's send: two re-sends at once cannot both pass the interval.
  const claimed = await env.DB.prepare(`
    update lane_shares set invite_email_count = invite_email_count + 1, last_invite_email_at = ?
    where id = ? and state = 'pending' and invite_email_count < ? and (last_invite_email_at is null or last_invite_email_at <= ?)
  `).bind(now, row.id, LANE_SHARE_MAX_EMAILS_PER_INVITE, now - LANE_SHARE_RESEND_INTERVAL_MS).run();
  if ((claimed.meta?.changes ?? 0) !== 1) {
    await giveBackGiver();
    await refundDay(env, day, toSubject);
    return { sent: false, reason: "rate_limited" };
  }
  const outcome = await sendLaneShareInviteEmail(env, {
    to: row.receiver_email,
    giverLabel: row.giver_label,
    projectLabel: row.project_label,
    laneLabel: row.lane_label,
    link: laneShareInviteLink(row.id),
  });
  if (outcome === "sent") return { sent: true, reason: null };
  await refundDay(env, day, toSubject);
  return { sent: false, reason: outcome === "not_configured" ? "not_configured" : "failed" };
}

// ---------------------------------------------------------------------------
// Handlers

async function handleInvite(request: Request, env: LaneShareEnv, userId: string, now: number): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const receiverEmail = parseEmail(body.receiverEmail);
  if (!receiverEmail) return badRequest("That email address isn't valid.");
  const repoKey = parseRepoKey(body.repoKey);
  if (!repoKey) return badRequest("That project can't be shared: it needs a Git remote.");
  const machineKey = parseMachineKey(body.machineKey);
  const laneId = parseLaneId(body.laneId);
  if (!machineKey || !laneId) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const preset = parsePreset(body.preset);
  const risk = parseRisk(body.risk);
  if (!preset || !risk) return badRequest("That access level isn't one ADE offers.");
  const endsAt = parseEndsAt(body.endsAt, now);
  if (endsAt === false) return badRequest("The end date must be in the future and within a year.");
  const projectLabel = parseLabel(body.projectLabel);
  const laneLabel = parseLabel(body.laneLabel);
  if (projectLabel === false || laneLabel === false) return badRequest(UNREADABLE_REQUEST_MESSAGE);

  const giver = await clerkAccount(env, userId);
  if (!giver) return clerkUnavailable();
  if (giver.verifiedEmails.includes(receiverEmail)) {
    logLaneShare({ event: "lane_share.refused", userId, code: "self_invite" });
    return fail("self_invite", "That's your own email address. Invite someone else.", 400);
  }
  if (!(await ownsMachine(env, userId, machineKey))) {
    logLaneShare({ event: "lane_share.refused", userId, code: "unknown_machine" });
    return fail("unknown_machine", "That computer isn't on your ADE account.", 400);
  }
  const giverLabel = boundedDisplayText(giver.displayName, MAX_GIVER_LABEL);
  const fields = { receiverEmail, repoKey, machineKey, laneId, preset, risk, endsAt: endsAt ?? null, projectLabel, laneLabel, giverLabel };

  await settleLane(env, userId, laneId, now);
  const existing = await existingForAddress(env, userId, laneId, receiverEmail);
  if (existing?.state === "active") return alreadyShared(userId, existing.id);
  if (existing) return refreshInvite(env, userId, existing, fields, now);

  const day = utcDayKey(now);
  if (!(await claimDay(env, day, giverSubject(userId), LANE_SHARE_DAILY_INVITES_PER_GIVER))) {
    logLaneShare({ event: "lane_share.refused", userId, code: "invite_limit" });
    return fail("invite_limit", `You can send ${LANE_SHARE_DAILY_INVITES_PER_GIVER} lane invites a day. Try again tomorrow.`, 429);
  }
  const id = newGrantId();
  let inserted: number;
  try {
    // The guest count and the insert are one statement, so two invites at once cannot make a sixth guest.
    const result = await env.DB.prepare(`
      insert into lane_shares (id, giver_user_id, receiver_email, repo_key, machine_key, lane_id, giver_label,
        project_label, lane_label, preset, risk, state, invite_expires_at, ends_at, version, created_at, updated_at)
      select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1, ?, ?
      where (select count(*) from lane_shares where giver_user_id = ? and lane_id = ? and state in ${LIVE_STATES}) < ?
    `).bind(
      id, userId, receiverEmail, repoKey, machineKey, laneId, giverLabel, projectLabel, laneLabel, preset, risk,
      now + LANE_SHARE_INVITE_TTL_MS, endsAt ?? null, now, now,
      userId, laneId, LANE_SHARE_MAX_GUESTS_PER_LANE,
    ).run();
    inserted = result.meta?.changes ?? 0;
  } catch (error) {
    await refundDay(env, day, giverSubject(userId));
    if (!isUniqueViolation(error)) throw error;
    // A concurrent invite to the same address won the insert: this call refreshes it.
    const raced = await existingForAddress(env, userId, laneId, receiverEmail);
    if (raced?.state === "pending") return refreshInvite(env, userId, raced, fields, now);
    return alreadyShared(userId, raced?.id ?? null);
  }
  if (inserted !== 1) {
    await refundDay(env, day, giverSubject(userId));
    logLaneShare({ event: "lane_share.refused", userId, code: "guest_limit" });
    return fail("guest_limit", `A lane can have at most ${LANE_SHARE_MAX_GUESTS_PER_LANE} guests. Remove one to invite someone else.`, 409);
  }
  const row = await reload(env, id);
  const email = await deliverInvite(env, row, now, true);
  logLaneShare({ event: "lane_share.invited", userId, grantId: id, emailSent: email.sent });
  return json(inviteResponse(await reload(env, id), now, false, email), 201);
}

type InviteFields = {
  receiverEmail: string;
  repoKey: string;
  machineKey: string;
  laneId: string;
  preset: LaneSharePreset;
  risk: LaneShareRisk;
  endsAt: number | null;
  projectLabel: string | null;
  laneLabel: string | null;
  giverLabel: string | null;
};

/** The live grant of one address on one lane, read after `settleLane`. */
async function existingForAddress(env: LaneShareEnv, giverUserId: string, laneId: string, email: string): Promise<ShareRow | null> {
  return env.DB.prepare(`
    select ${COLUMNS} from lane_shares
    where giver_user_id = ? and lane_id = ? and receiver_email = ? and state in ${LIVE_STATES}
    order by state = 'active' desc limit 1
  `).bind(giverUserId, laneId, email).first<ShareRow>();
}

function alreadyShared(userId: string, grantId: string | null): Response {
  logLaneShare({ event: "lane_share.refused", userId, grantId: grantId ?? undefined, code: "already_shared" });
  return fail("already_shared", "This lane is already shared with that person.", 409);
}

/**
 * A second invite to an address with a pending invite on the same lane: the
 * 24 h window starts again, the invite takes the new access level and end
 * date, and the email goes again when the re-send limits allow.
 */
async function refreshInvite(env: LaneShareEnv, userId: string, row: ShareRow, fields: InviteFields, now: number): Promise<Response> {
  const result = await env.DB.prepare(`
    update lane_shares set invite_expires_at = ?, preset = ?, risk = ?, ends_at = ?,
      project_label = coalesce(?, project_label), lane_label = coalesce(?, lane_label), giver_label = coalesce(?, giver_label),
      updated_at = ?, version = version + 1
    where id = ? and giver_user_id = ? and state = 'pending'
  `).bind(
    now + LANE_SHARE_INVITE_TTL_MS, fields.preset, fields.risk, fields.endsAt,
    fields.projectLabel, fields.laneLabel, fields.giverLabel, now, row.id, userId,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    // Accepted, revoked or declined between the read and this write.
    const current = await reload(env, row.id);
    return current.state === "active" ? alreadyShared(userId, row.id) : shareClosed();
  }
  const refreshed = await reload(env, row.id);
  const email = await deliverInvite(env, refreshed, now, false);
  logLaneShare({ event: "lane_share.refreshed", userId, grantId: row.id, emailSent: email.sent });
  return json(inviteResponse(await reload(env, row.id), now, true, email), 200);
}

function inviteResponse(row: ShareRow, now: number, refreshed: boolean, email: { sent: boolean; reason: LaneShareEmailNotSentReason | null }): LaneShareInviteResponse {
  const grant = giverView(row, now);
  return { grant, refreshed, emailSent: email.sent, emailNotSentReason: email.reason, link: grant.link };
}

/** Rows that closed before this are left out of the lists. */
const listCutoff = (now: number) => now - LANE_SHARE_CLOSED_VISIBLE_MS;

function stillListed(row: ShareRow, now: number): boolean {
  const closedAt = effectiveClosedAt(row, now);
  return closedAt == null || closedAt > listCutoff(now);
}

async function handleGiven(env: LaneShareEnv, userId: string, now: number): Promise<Response> {
  const rows = await env.DB.prepare(`
    select ${COLUMNS} from lane_shares
    where giver_user_id = ? and (closed_at is null or closed_at > ?)
    order by created_at desc limit ?
  `).bind(userId, listCutoff(now), LIST_LIMIT).all<ShareRow>();
  const grants = (rows.results ?? []).filter((row) => stillListed(row, now)).map((row) => giverView(row, now));
  return json({ grants });
}

async function handleReceived(env: LaneShareEnv, userId: string, now: number): Promise<Response> {
  const accepted = await env.DB.prepare(`
    select ${COLUMNS} from lane_shares
    where receiver_user_id = ? and (closed_at is null or closed_at > ?)
    order by created_at desc limit ?
  `).bind(userId, listCutoff(now), LIST_LIMIT).all<ShareRow>();
  const grants = (accepted.results ?? []).filter((row) => stillListed(row, now)).map((row) => receiverView(row, now));

  const account = await clerkAccount(env, userId);
  const emails = account?.verifiedEmails.slice(0, MAX_EMAILS_PER_LOOKUP) ?? [];
  if (emails.length) {
    const pending = await env.DB.prepare(`
      select ${COLUMNS} from lane_shares
      where receiver_email in (${emails.map(() => "?").join(", ")})
        and state = 'pending' and receiver_user_id is null and giver_user_id <> ? and invite_expires_at > ?
      order by created_at desc limit ?
    `).bind(...emails, userId, now, LIST_LIMIT).all<ShareRow>();
    for (const row of pending.results ?? []) {
      if (effectiveState(row, now) === "pending") grants.push(receiverView(row, now));
    }
  }
  const response: LaneShareReceivedResponse = { grants, pendingInvitesUnavailable: account === null };
  return json(response);
}

async function handleHostRead(request: Request, env: LaneShareEnv, userId: string, now: number): Promise<Response> {
  const body = await readJsonBody(request);
  const machineKey = parseMachineKey(body?.machineKey);
  if (!machineKey) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  // A removed machine keeps a valid account token; without its machine row it reads nothing.
  if (!(await ownsMachine(env, userId, machineKey))) return fail("unknown_machine", "That computer isn't on your ADE account.", 404);
  const rows = await env.DB.prepare(`
    select ${COLUMNS} from lane_shares
    where giver_user_id = ? and machine_key = ? and (state in ${LIVE_STATES} or closed_at > ?)
    order by created_at desc limit ?
  `).bind(userId, machineKey, now - LANE_SHARE_HOST_CLOSED_WINDOW_MS, HOST_LIMIT).all<ShareRow>();
  const response: LaneShareHostResponse = { serverTime: now, grants: [], closed: [] };
  for (const row of rows.results ?? []) {
    const state = effectiveState(row, now);
    if (state === "pending" || state === "active") {
      response.grants.push({
        id: row.id,
        receiverUserId: state === "active" ? row.receiver_user_id : null,
        laneId: row.lane_id,
        repoKey: row.repo_key,
        state,
        endsAt: row.ends_at,
        preset: row.preset,
        risk: row.risk,
        version: row.version,
      });
    } else {
      const closedAt = effectiveClosedAt(row, now);
      if (closedAt != null && closedAt <= now - LANE_SHARE_HOST_CLOSED_WINDOW_MS) continue;
      response.closed.push({ id: row.id, receiverUserId: row.receiver_user_id, laneId: row.lane_id, state, closedAt, version: row.version });
    }
  }
  return json(response);
}

/** Whether a verified address of `account` is the one a pending, unclaimed invite went to. */
const isInvitee = (row: ShareRow, account: ClerkAccount, userId: string): boolean =>
  row.receiver_user_id === null && row.giver_user_id !== userId && account.verifiedEmails.includes(row.receiver_email);

async function handleOpen(env: LaneShareEnv, userId: string, id: string, now: number): Promise<Response> {
  const row = await loadRow(env, id);
  if (row?.giver_user_id === userId) return json({ role: "giver", grant: giverView(row, now) } satisfies LaneShareOpenResponse);
  if (row && row.receiver_user_id === userId) return json({ role: "receiver", grant: receiverView(row, now) } satisfies LaneShareOpenResponse);
  // Asked for every other caller, whether or not the row exists: the answer must not tell them apart.
  const account = await clerkAccount(env, userId);
  if (!account) return clerkUnavailable();
  if (!row || !isInvitee(row, account, userId)) return notFound();
  return json({ role: "invitee", grant: receiverView(row, now) } satisfies LaneShareOpenResponse);
}

async function handleAccept(env: LaneShareEnv, userId: string, id: string, now: number): Promise<Response> {
  const row = await loadRow(env, id);
  // The same receiver again (a retry, a second device): nothing to change.
  if (row && row.receiver_user_id === userId) return json({ grant: receiverView(row, now) });
  if (row?.giver_user_id === userId) return fail("self_invite", "You can't accept your own lane share.", 400);
  const account = await clerkAccount(env, userId);
  if (!account) return clerkUnavailable();
  if (!row || !isInvitee(row, account, userId)) {
    logLaneShare({ event: "lane_share.refused", userId, code: "accept_not_found" });
    return notFound();
  }
  const state = effectiveState(row, now);
  if (state === "expired") return fail("invite_expired", "This invite has expired. Ask for a new one.", 410);
  if (state !== "pending") return shareClosed();

  await settleLane(env, row.giver_user_id, row.lane_id, now);
  let changes: number;
  try {
    // One conditional write: of two accepts at once only one sees a pending, unclaimed row.
    const result = await env.DB.prepare(`
      update lane_shares set state = 'active', receiver_user_id = ?, accepted_at = ?, updated_at = ?, version = version + 1
      where id = ? and state = 'pending' and receiver_user_id is null and giver_user_id <> ?
        and invite_expires_at > ? and (ends_at is null or ends_at > ?)
    `).bind(userId, now, now, id, userId, now, now).run();
    changes = result.meta?.changes ?? 0;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // This account already has an active grant on the lane through another invite.
    return alreadyShared(userId, id);
  }
  const current = await reload(env, id);
  if (changes === 1 || current.receiver_user_id === userId) {
    if (changes === 1) logLaneShare({ event: "lane_share.accepted", userId, grantId: id });
    return json({ grant: receiverView(current, now) });
  }
  const after = effectiveState(current, now);
  if (after === "expired") return fail("invite_expired", "This invite has expired. Ask for a new one.", 410);
  if (current.receiver_user_id !== null) return notFound();
  return shareClosed();
}

async function handleRevoke(env: LaneShareEnv, userId: string, id: string, now: number): Promise<Response> {
  const row = await loadRow(env, id);
  if (!row || row.giver_user_id !== userId) return notFound();
  const result = await env.DB.prepare(`
    update lane_shares set state = 'revoked', closed_at = ?, updated_at = ?, version = version + 1
    where id = ? and giver_user_id = ? and state in ${LIVE_STATES}
  `).bind(now, now, id, userId).run();
  if ((result.meta?.changes ?? 0) === 1) logLaneShare({ event: "lane_share.revoked", userId, grantId: id });
  return json({ grant: giverView(await reload(env, id), now) });
}

async function handleLeave(env: LaneShareEnv, userId: string, id: string, now: number): Promise<Response> {
  const row = await loadRow(env, id);
  if (row?.giver_user_id === userId) return badRequest("You shared this lane: stop sharing it instead.");
  if (row && row.receiver_user_id === userId) {
    const result = await env.DB.prepare(`
      update lane_shares set state = 'left', closed_at = ?, updated_at = ?, version = version + 1
      where id = ? and receiver_user_id = ? and state in ${LIVE_STATES}
    `).bind(now, now, id, userId).run();
    if ((result.meta?.changes ?? 0) === 1) logLaneShare({ event: "lane_share.left", userId, grantId: id });
    return json({ grant: receiverView(await reload(env, id), now) });
  }
  const account = await clerkAccount(env, userId);
  if (!account) return clerkUnavailable();
  if (!row || !isInvitee(row, account, userId)) return notFound();
  // Declining an invite: same final state as leaving.
  const result = await env.DB.prepare(`
    update lane_shares set state = 'left', closed_at = ?, updated_at = ?, version = version + 1
    where id = ? and receiver_user_id is null and state = 'pending'
  `).bind(now, now, id).run();
  if ((result.meta?.changes ?? 0) === 1) logLaneShare({ event: "lane_share.declined", userId, grantId: id });
  return json({ grant: receiverView(await reload(env, id), now) });
}

const EDITABLE = new Set(["endsAt", "preset", "risk"]);

async function handleEdit(request: Request, env: LaneShareEnv, userId: string, id: string, now: number): Promise<Response> {
  const body = await readJsonBody(request);
  const row = await loadRow(env, id);
  if (!row || row.giver_user_id !== userId) return notFound();
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const keys = Object.keys(body);
  if (!keys.length || keys.some((key) => !EDITABLE.has(key))) return badRequest("Only the end date and the access level can be changed.");
  const endsAt = parseEndsAt(body.endsAt, now);
  if (endsAt === false) return badRequest("The end date must be in the future and within a year.");
  const preset = body.preset === undefined ? undefined : parsePreset(body.preset);
  const risk = body.risk === undefined ? undefined : parseRisk(body.risk);
  if (preset === null || risk === null) return badRequest("That access level isn't one ADE offers.");
  const state = effectiveState(row, now);
  if (state !== "pending" && state !== "active") return shareClosed();
  const result = await env.DB.prepare(`
    update lane_shares set
      ends_at = case when ? then ? else ends_at end,
      preset = coalesce(?, preset),
      risk = coalesce(?, risk),
      updated_at = ?, version = version + 1
    where id = ? and giver_user_id = ? and state in ${LIVE_STATES}
      and (ends_at is null or ends_at > ?) and (state = 'active' or invite_expires_at > ?)
  `).bind(endsAt !== undefined ? 1 : 0, endsAt ?? null, preset ?? null, risk ?? null, now, id, userId, now, now).run();
  if ((result.meta?.changes ?? 0) !== 1) return shareClosed();
  logLaneShare({ event: "lane_share.edited", userId, grantId: id });
  return json({ grant: giverView(await reload(env, id), now) });
}

/**
 * The lane moved to another machine of the giver: every live grant of that
 * lane follows, so the grants of one lane never point at two machines. The
 * old machine's next host read no longer lists them.
 */
async function handleMove(request: Request, env: LaneShareEnv, userId: string, id: string, now: number): Promise<Response> {
  const body = await readJsonBody(request);
  const row = await loadRow(env, id);
  if (!row || row.giver_user_id !== userId) return notFound();
  const machineKey = parseMachineKey(body?.machineKey);
  if (!machineKey) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  if (!(await ownsMachine(env, userId, machineKey))) return fail("unknown_machine", "That computer isn't on your ADE account.", 400);
  const state = effectiveState(row, now);
  if (state !== "pending" && state !== "active") return shareClosed();
  await settleLane(env, userId, row.lane_id, now);
  const result = await env.DB.prepare(`
    update lane_shares set machine_key = ?, updated_at = ?, version = version + 1
    where giver_user_id = ? and lane_id = ? and state in ${LIVE_STATES} and machine_key <> ?
  `).bind(machineKey, now, userId, row.lane_id, machineKey).run();
  logLaneShare({ event: "lane_share.moved", userId, grantId: id });
  return json({ grant: giverView(await reload(env, id), now), moved: result.meta?.changes ?? 0 });
}

// ---------------------------------------------------------------------------
// Account deletion and the cron

/**
 * Clerk `user.deleted`: every live grant given by the account is revoked and
 * every live grant it received is left, so no host keeps a guest whose
 * account is gone and no guest keeps a lane whose owner is gone. Safe to
 * repeat. Pending invites TO the account's address are not found here (the
 * address is gone with the account); they expire in 24 h.
 */
export async function closeLaneSharesForAccount(env: { DB: D1Database }, userId: string, now: number = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`
      update lane_shares set state = 'revoked', closed_reason = 'account_deleted', closed_at = ?, updated_at = ?, version = version + 1
      where giver_user_id = ? and state in ${LIVE_STATES}
    `).bind(now, now, userId),
    env.DB.prepare(`
      update lane_shares set state = 'left', closed_reason = 'account_deleted', closed_at = ?, updated_at = ?, version = version + 1
      where receiver_user_id = ? and state in ${LIVE_STATES}
    `).bind(now, now, userId),
  ]);
}

const SWEEP_BATCH = 500;
const KEEP_CLOSED_MS = 90 * 24 * 60 * 60 * 1000;
const KEEP_BUDGET_DAYS = 7;

/**
 * Cron: writes the clock-derived states (so closed rows get a `closed_at` and
 * leave the lists), deletes rows closed more than 90 days ago, and drops
 * invite budget rows older than a week. Bounded per tick.
 */
export async function cleanupLaneShares(env: { DB: D1Database }, now: number = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`
      update lane_shares set state = 'ended', closed_at = ends_at, updated_at = ?, version = version + 1
      where id in (select id from lane_shares where state in ${LIVE_STATES} and ends_at is not null and ends_at <= ? limit ?)
    `).bind(now, now, SWEEP_BATCH),
    env.DB.prepare(`
      update lane_shares set state = 'expired', closed_at = invite_expires_at, updated_at = ?, version = version + 1
      where id in (select id from lane_shares where state = 'pending' and invite_expires_at <= ? limit ?)
    `).bind(now, now, SWEEP_BATCH),
    env.DB.prepare(`
      delete from lane_shares where id in (select id from lane_shares where closed_at is not null and closed_at < ? limit ?)
    `).bind(now - KEEP_CLOSED_MS, SWEEP_BATCH),
    env.DB.prepare("delete from lane_share_invite_days where day < ?")
      .bind(utcDayKey(now - KEEP_BUDGET_DAYS * 24 * 60 * 60 * 1000)),
  ]);
}
