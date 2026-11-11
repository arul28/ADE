import { authenticate } from "../callerToken";
import { UNREADABLE_REQUEST_MESSAGE, fail, json } from "../cloud/http";
import { boundedDisplayText } from "../displayText";
import { logLaneShare } from "../logging";
import { utcDayKey } from "../sinkUtils";
import { trustedHttpsOrigin } from "../trustedOrigin";
import { clerkAccount, type ClerkAccount } from "./clerkAccount";
import {
  LANE_SHARE_CLOSED_VISIBLE_MS,
  LANE_SHARE_PATHS,
  type LaneShareOpenResponse,
  type LaneShareReceivedResponse,
} from "./contract";
import {
  badRequest,
  budgetedClerkAccount,
  clerkBudgetSpent,
  clerkUnavailable,
  COLUMNS,
  effectiveClosedAt,
  effectiveState,
  giverView,
  isUniqueViolation,
  type LaneShareEnv,
  LIST_LIMIT,
  LIVE_STATES,
  loadRow,
  MAX_EMAILS_PER_LOOKUP,
  MAX_GIVER_LABEL,
  notFound,
  ownsMachine,
  parseEndsAt,
  parseMachineKey,
  parsePreset,
  parseRisk,
  PREFIX,
  readJsonBody,
  receiverView,
  reload,
  settleLane,
  shareClosed,
  type ShareRow,
} from "./shareRows";
import {
  alreadyShared,
  handleInvite,
} from "./invites";
import {
  handleConnect,
  handleHostRead,
  handleRedeem,
  HOUR_MS,
} from "./tickets";

export type { LaneShareEnv } from "./shareRows";

/**
 * Lane sharing: the account-level record of grants (README, "Lane sharing";
 * table in migration 0020; shapes in `contract.ts`).
 *
 * Default refuse. Every route reads the row and compares the caller's user id
 * with it; a pending invite is matched against the addresses Clerk has
 * VERIFIED for the caller, read fresh on each call (`clerkAccount`). A caller
 * who may not see a grant gets the same 404 as an id that does not exist, and
 * the routes that may need Clerk ask it before deciding that 404, so whether
 * Clerk is reachable says nothing about whether an id exists.
 *
 * This Worker never opens a machine. The host machine keeps the rights and
 * redeems the guest's one-use ticket (`POST /lane-shares/host/redeem`) on
 * every guest connection; that read goes to D1 with no cache, so a revoke is
 * visible to the next connection at once. A guest's account token comes only
 * here; the host sees the ticket, never the token.
 */

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
  | { kind: "redeem" }
  | { kind: "grant"; id: string }
  | { kind: "action"; id: string; action: LaneShareAction };

type LaneShareAction = "accept" | "revoke" | "leave" | "move" | "connect";
const ACTIONS = new Set<string>(["accept", "revoke", "leave", "move", "connect"]);

function matchRoute(path: string): Route | null {
  if (path === PREFIX) return { kind: "invite" };
  if (path === LANE_SHARE_PATHS.given) return { kind: "given" };
  if (path === LANE_SHARE_PATHS.received) return { kind: "received" };
  if (path === LANE_SHARE_PATHS.host) return { kind: "host" };
  if (path === LANE_SHARE_PATHS.hostRedeem) return { kind: "redeem" };
  const [id, action, ...rest] = path.slice(PREFIX.length + 1).split("/");
  if (!id || rest.length) return null;
  if (action === undefined) return { kind: "grant", id };
  return ACTIONS.has(action) ? { kind: "action", id, action: action as LaneShareAction } : null;
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
 * and the ticket redeem are for machines only, so no browser origin may call
 * them. A refused origin is answered before the token or D1 is touched.
 */
export async function handleLaneShareRequest(request: Request, env: LaneShareEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const route = matchRoute(path);
  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = trustedHttpsOrigin(env.WEB_CLIENT_ORIGIN, { requireExactOrigin: true });
  const machineOnly = route?.kind === "host" || route?.kind === "redeem";
  const corsOrigin = route && !machineOnly && requestOrigin && allowedOrigin && requestOrigin === allowedOrigin
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
    case "redeem":
      return handleRedeem(request, env, userId, now);
    case "grant":
      return request.method === "GET" ? handleOpen(env, userId, route.id, now) : handleEdit(request, env, userId, route.id, now);
    case "action":
      if (route.action === "accept") return handleAccept(env, userId, route.id, now);
      if (route.action === "revoke") return handleRevoke(env, userId, route.id, now);
      if (route.action === "leave") return handleLeave(env, userId, route.id, now);
      if (route.action === "connect") return handleConnect(request, env, userId, route.id, now);
      return handleMove(request, env, userId, route.id, now);
  }
}

// ---------------------------------------------------------------------------
// Rows, state and views

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

  // Over the Clerk budget the accepted grants still list; pending invites read as unavailable.
  const lookup = await budgetedClerkAccount(env, userId, now);
  const account = lookup === "over_budget" ? null : lookup;
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

/** Whether a verified address of `account` is the one a pending, unclaimed invite went to. */
const isInvitee = (row: ShareRow, account: ClerkAccount, userId: string): boolean =>
  row.receiver_user_id === null && row.giver_user_id !== userId && account.verifiedEmails.includes(row.receiver_email);

async function handleOpen(env: LaneShareEnv, userId: string, id: string, now: number): Promise<Response> {
  const row = await loadRow(env, id);
  if (row?.giver_user_id === userId) return json({ role: "giver", grant: giverView(row, now) } satisfies LaneShareOpenResponse);
  if (row && row.receiver_user_id === userId) return json({ role: "receiver", grant: receiverView(row, now) } satisfies LaneShareOpenResponse);
  // Asked for every other caller, whether or not the row exists: the answer must not tell them apart.
  const account = await budgetedClerkAccount(env, userId, now);
  if (account === "over_budget") return clerkBudgetSpent();
  if (!account) return clerkUnavailable();
  if (!row || !isInvitee(row, account, userId)) return notFound();
  return json({ role: "invitee", grant: receiverView(row, now) } satisfies LaneShareOpenResponse);
}

async function handleAccept(env: LaneShareEnv, userId: string, id: string, now: number): Promise<Response> {
  const row = await loadRow(env, id);
  // The same receiver again (a retry, a second device): nothing to change.
  if (row && row.receiver_user_id === userId) return json({ grant: receiverView(row, now) });
  if (row?.giver_user_id === userId) return fail("self_invite", "You can't accept your own lane share.", 400);
  const account = await budgetedClerkAccount(env, userId, now);
  if (account === "over_budget") return clerkBudgetSpent();
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
      update lane_shares set state = 'active', receiver_user_id = ?, receiver_label = ?, accepted_at = ?, updated_at = ?, version = version + 1
      where id = ? and state = 'pending' and receiver_user_id is null and giver_user_id <> ?
        and invite_expires_at > ? and (ends_at is null or ends_at > ?)
    `).bind(userId, boundedDisplayText(account.displayName, MAX_GIVER_LABEL), now, now, id, userId, now, now).run();
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
  const account = await budgetedClerkAccount(env, userId, now);
  if (account === "over_budget") return clerkBudgetSpent();
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
 * leave the lists), deletes rows closed more than 90 days ago, drops invite
 * budget rows older than a week, and deletes connection tickets older than
 * the mint cap's hour (a ticket lives two minutes). Bounded per tick.
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
    env.DB.prepare(`
      delete from lane_share_tickets where ticket_hash in (select ticket_hash from lane_share_tickets where created_at < ? limit ?)
    `).bind(now - HOUR_MS, SWEEP_BATCH),
  ]);
}
