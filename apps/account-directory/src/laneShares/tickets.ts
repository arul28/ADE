import { UNREADABLE_REQUEST_MESSAGE, fail, json } from "../cloud/http";
import { logLaneShare } from "../logging";
import { sha256Hex } from "../sinkUtils";
import { personName } from "../cloud/email";
import {
  LANE_SHARE_HOST_CLOSED_WINDOW_MS,
  LANE_SHARE_TICKET_MINTS_PER_HOUR,
  LANE_SHARE_TICKET_PATTERN,
  LANE_SHARE_TICKET_TTL_MS,
  type LaneShareConnectResponse,
  type LaneShareHostResponse,
  type LaneShareRedeemResponse,
} from "./contract";
import {
  badRequest,
  COLUMNS,
  effectiveClosedAt,
  effectiveState,
  HOST_LIMIT,
  type LaneShareEnv,
  LIVE_STATES,
  loadRow,
  notFound,
  ownsMachine,
  parseMachineKey,
  readJsonBody,
  shareClosed,
  type ShareRow,
} from "./shareRows";

/**
 * The connection routes of lane sharing: the host's grant list, the
 * guest's one-use ticket and the host's redeem of it.
 */

export async function handleHostRead(request: Request, env: LaneShareEnv, userId: string, now: number): Promise<Response> {
  const body = await readJsonBody(request);
  const machineKey = parseMachineKey(body?.machineKey);
  if (!machineKey) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  // A removed machine keeps a valid account token; without its machine row it reads nothing.
  if (!(await ownsMachine(env, userId, machineKey))) return fail("unknown_machine", "That computer isn't on your ADE account.", 404);
  return json(await hostGrantList(env, userId, machineKey, now));
}

/** The complete live grant list of one machine of `userId`, plus recently closed ones. */
async function hostGrantList(env: LaneShareEnv, userId: string, machineKey: string, now: number): Promise<LaneShareHostResponse> {
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
        receiverName: state === "active" ? personName(row.receiver_label) : null,
        createdAt: row.created_at,
        acceptedAt: state === "active" ? row.accepted_at : null,
      });
    } else {
      const closedAt = effectiveClosedAt(row, now);
      if (closedAt != null && closedAt <= now - LANE_SHARE_HOST_CLOSED_WINDOW_MS) continue;
      response.closed.push({ id: row.id, receiverUserId: row.receiver_user_id, laneId: row.lane_id, state, closedAt, version: row.version });
    }
  }
  return response;
}

/** Same window as the machine list's online state (`DEFAULT_ONLINE_WINDOW_MS` in directory.ts). */
const HOST_ONLINE_WINDOW_MS = 150_000;

/**
 * The relay address a host machine published for itself: a `wss:` URL whose
 * path ends in `/connect/<machineKey>` (`ws:` only on this computer, for a
 * local relay). Anything else is not handed to a guest.
 */
function publishedRelayUrl(endpointsJson: string | null, machineKey: string): string | null {
  if (!endpointsJson) return null;
  let endpoints: unknown;
  try {
    endpoints = JSON.parse(endpointsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(endpoints)) return null;
  for (const endpoint of endpoints) {
    if (!endpoint || typeof endpoint !== "object") continue;
    const { kind, url } = endpoint as { kind?: unknown; url?: unknown };
    if (kind !== "relay" || typeof url !== "string") continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "wss:" && !(parsed.protocol === "ws:" && local)) continue;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) continue;
    const tail = parsed.pathname.split("/").slice(-2);
    if (tail[0] !== "connect" || decodeURIComponent(tail[1] ?? "") !== machineKey) continue;
    return parsed.toString();
  }
  return null;
}

export const HOUR_MS = 60 * 60 * 1000;

/** 32 random bytes, base64url: the ticket the guest hands the host. */
function newTicket(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const ticketHash = (ticket: string) => sha256Hex(`lane-share-ticket:${ticket}`);

/**
 * The receiver of an ACTIVE grant asks how to reach the host, and gets a
 * one-use ticket for it. Everyone else, the giver included, gets the same
 * 404 as an unknown id; a closed grant answers 410. The relay address only
 * admits a socket: the host redeems the ticket (`POST /lane-shares/host/redeem`)
 * on every connection, so the guest's account token never leaves this call.
 */
export async function handleConnect(request: Request, env: LaneShareEnv, userId: string, id: string, now: number): Promise<Response> {
  const body = await readJsonBody(request);
  const dpopThumbprint = typeof body?.dpopThumbprint === "string" && LANE_SHARE_TICKET_PATTERN.test(body.dpopThumbprint)
    ? body.dpopThumbprint
    : null;
  const row = await loadRow(env, id);
  if (!row || row.receiver_user_id !== userId) return notFound();
  if (effectiveState(row, now) !== "active") return shareClosed();
  if (!dpopThumbprint) return badRequest("Update ADE: this version can't connect to a shared lane.");
  const machine = await env.DB.prepare(
    "select reachable_endpoints, last_seen_at from machines where user_id = ? and machine_key = ?",
  ).bind(row.giver_user_id, row.machine_key).first<{ reachable_endpoints: string | null; last_seen_at: number | null }>();
  const relayUrl = machine ? publishedRelayUrl(machine.reachable_endpoints, row.machine_key) : null;
  let ticket: string | null = null;
  let ticketExpiresAt: number | null = null;
  if (relayUrl) {
    ticket = newTicket();
    ticketExpiresAt = now + LANE_SHARE_TICKET_TTL_MS;
    // The mint cap and the insert are one statement, so concurrent mints cannot pass it together.
    const minted = await env.DB.prepare(`
      insert into lane_share_tickets (ticket_hash, grant_id, receiver_user_id, machine_key, dpop_thumbprint, created_at, expires_at)
      select ?, ?, ?, ?, ?, ?, ?
      where (select count(*) from lane_share_tickets where grant_id = ? and created_at > ?) < ?
    `).bind(
      await ticketHash(ticket), row.id, userId, row.machine_key, dpopThumbprint, now, ticketExpiresAt,
      row.id, now - HOUR_MS, LANE_SHARE_TICKET_MINTS_PER_HOUR,
    ).run();
    if ((minted.meta?.changes ?? 0) !== 1) {
      logLaneShare({ event: "lane_share.refused", userId, grantId: row.id, code: "ticket_limit" });
      return fail("rate_limited", "Too many connection attempts to this shared lane. Try again later.", 429);
    }
    logLaneShare({ event: "lane_share.ticket_minted", userId, grantId: row.id });
  }
  const response: LaneShareConnectResponse = {
    grantId: row.id,
    laneId: row.lane_id,
    repoKey: row.repo_key,
    relayUrl,
    hostOnline: Boolean(machine?.last_seen_at != null && now - machine.last_seen_at <= HOST_ONLINE_WINDOW_MS),
    ticket,
    ticketExpiresAt,
  };
  return json(response);
}

/**
 * A host machine redeems a guest's ticket with its owner's account token.
 * One conditional UPDATE marks it used, and only when it is unused, not
 * expired, minted for this machine, and its grant is still active with the
 * same receiver and machine and the caller as the giver, on the server clock.
 * So of two redeems at once one wins, and a revoke between mint and redeem
 * refuses it. Every failure answers the same 404.
 */
export async function handleRedeem(request: Request, env: LaneShareEnv, userId: string, now: number): Promise<Response> {
  const body = await readJsonBody(request);
  const machineKey = parseMachineKey(body?.machineKey);
  const ticket = typeof body?.ticket === "string" && LANE_SHARE_TICKET_PATTERN.test(body.ticket) ? body.ticket : null;
  if (!machineKey || !ticket || !(await ownsMachine(env, userId, machineKey))) return notFound();
  const hash = await ticketHash(ticket);
  const used = await env.DB.prepare(`
    update lane_share_tickets set used_at = ?
    where ticket_hash = ? and used_at is null and expires_at > ? and machine_key = ?
      and exists (
        select 1 from lane_shares s
        where s.id = lane_share_tickets.grant_id
          and s.giver_user_id = ?
          and s.machine_key = lane_share_tickets.machine_key
          and s.receiver_user_id = lane_share_tickets.receiver_user_id
          and s.state = 'active'
          and (s.ends_at is null or s.ends_at > ?)
      )
  `).bind(now, hash, now, machineKey, userId, now).run();
  if ((used.meta?.changes ?? 0) !== 1) {
    logLaneShare({ event: "lane_share.refused", userId, code: "ticket_refused" });
    return notFound();
  }
  const redeemed = await env.DB.prepare(`
    select t.grant_id, t.receiver_user_id, t.dpop_thumbprint, s.lane_id, s.repo_key
    from lane_share_tickets t join lane_shares s on s.id = t.grant_id
    where t.ticket_hash = ?
  `).bind(hash).first<{ grant_id: string; receiver_user_id: string; dpop_thumbprint: string; lane_id: string; repo_key: string }>();
  if (!redeemed) return notFound();
  logLaneShare({ event: "lane_share.ticket_redeemed", userId, grantId: redeemed.grant_id });
  const response: LaneShareRedeemResponse = {
    ...(await hostGrantList(env, userId, machineKey, now)),
    redeemed: {
      grantId: redeemed.grant_id,
      receiverUserId: redeemed.receiver_user_id,
      laneId: redeemed.lane_id,
      repoKey: redeemed.repo_key,
      dpopThumbprint: redeemed.dpop_thumbprint,
    },
  };
  return json(response);
}
