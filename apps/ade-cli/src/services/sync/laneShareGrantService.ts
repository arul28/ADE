import {
  createAccountDirectoryCorrelationId,
  readBoundedAccountDirectoryJson,
  resolveTrustedAccountDirectoryBaseUrl,
} from "../../../../desktop/src/shared/accountDirectory";
import type { LaneShareGuestGrant } from "./laneShareGuestPolicy";

/**
 * The lane-share grants of THIS machine, read from the account directory
 * (`POST /lane-shares/host`, README "Lane sharing") with the machine owner's
 * own account token. The directory answers the complete live set; a grant
 * that is not in the answer gives no access.
 *
 * The host keeps the last good answer in memory only. A guest hello redeems
 * the guest's one-use ticket (`POST /lane-shares/host/redeem`), which answers
 * the guest's user id and a fresh list in one call; while a guest is
 * connected the sync host refreshes the list on a timer
 * (`LANE_SHARE_GRANT_REFRESH_MS`). Nothing here runs while no guest is
 * connected: no timer, no request. The guest's own account token never comes
 * here.
 *
 * Fail closed. A caller that needs a decision gets either a fresh list or a
 * thrown `LaneShareGrantError`, never a guess.
 */

/** While a guest is connected, the host reads its grants again this often. */
export const LANE_SHARE_GRANT_REFRESH_MS = 30_000;
/**
 * A connected guest stays only while the host's last good list is at most this
 * old. Three refresh periods: two failed reads in a row are tolerated (a
 * directory blip), a third closes every guest connection.
 */
export const LANE_SHARE_GRANT_MAX_AGE_MS = 90_000;

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_GRANTS = 1_000;
const GRANT_ID = /^ls_[0-9a-f]{32}$/;
/** A ticket and a DPoP key thumbprint: 43 base64url characters (account-directory contract). */
const TICKET = /^[A-Za-z0-9_-]{43}$/;

export type LaneShareGrantErrorCode =
  | "signed_out"
  | "no_directory"
  | "unknown_machine"
  | "ticket_refused"
  | "unavailable"
  | "invalid_response";

export class LaneShareGrantError extends Error {
  constructor(readonly code: LaneShareGrantErrorCode, message: string) {
    super(message);
    this.name = "LaneShareGrantError";
  }
}

export type LaneShareHostGrantRecord = {
  id: string;
  receiverUserId: string | null;
  laneId: string;
  state: "pending" | "active";
  endsAt: number | null;
};

export type LaneShareGrantSnapshot = {
  grants: readonly LaneShareHostGrantRecord[];
  /** Host clock when the answer arrived. */
  fetchedAtMs: number;
  /** Directory clock minus host clock, so `endsAt` is read on the directory's clock. */
  serverOffsetMs: number;
};

/** What the directory says a redeemed ticket names. Never from the guest. */
export type LaneShareTicketRedemption = {
  grantId: string;
  receiverUserId: string;
  laneId: string;
  dpopThumbprint: string;
};

export type LaneShareGrantSource = {
  /**
   * A list no older than `maxAgeMs` (default: always a new read). Concurrent
   * calls share one request. Throws `LaneShareGrantError` on any failure.
   */
  refresh(options?: { maxAgeMs?: number }): Promise<LaneShareGrantSnapshot>;
  /**
   * Redeems a guest's ticket, once. Resolves with what the ticket names and
   * the fresh list read in the same call (also kept as the last good list).
   * Throws `LaneShareGrantError`: `ticket_refused` for a ticket the directory
   * does not honor (unknown, used, expired, another machine, a grant no
   * longer active), anything else when it could not be asked.
   */
  redeem(ticket: string): Promise<{ redemption: LaneShareTicketRedemption; snapshot: LaneShareGrantSnapshot }>;
  /** The last good list, or null when none was read yet. */
  current(): LaneShareGrantSnapshot | null;
  /** Called after each good read. Returns the unsubscribe function. */
  subscribe(listener: (snapshot: LaneShareGrantSnapshot) => void): () => void;
};

/**
 * The redeem answer: what the ticket names, plus the host list. The whole
 * answer or nothing.
 */
export function parseLaneShareRedeemResponse(value: unknown): {
  redemption: LaneShareTicketRedemption;
  list: { serverTime: number; grants: LaneShareHostGrantRecord[] };
} {
  const list = parseLaneShareHostResponse(value);
  const redeemed = (value as { redeemed?: unknown }).redeemed;
  const record = redeemed && typeof redeemed === "object" && !Array.isArray(redeemed) ? redeemed as Record<string, unknown> : null;
  const grantId = typeof record?.grantId === "string" && GRANT_ID.test(record.grantId) ? record.grantId : null;
  const receiverUserId = typeof record?.receiverUserId === "string" && record.receiverUserId.trim() ? record.receiverUserId.trim() : null;
  const laneId = typeof record?.laneId === "string" && record.laneId.trim() ? record.laneId.trim() : null;
  const dpopThumbprint = typeof record?.dpopThumbprint === "string" && TICKET.test(record.dpopThumbprint) ? record.dpopThumbprint : null;
  if (!grantId || !receiverUserId || !laneId || !dpopThumbprint) {
    throw new LaneShareGrantError("invalid_response", "The ticket answer was malformed.");
  }
  return { redemption: { grantId, receiverUserId, laneId, dpopThumbprint }, list };
}

/** The active grants a user holds in `snapshot`, read on the directory's clock. */
export function activeLaneShareGrantsFor(
  snapshot: LaneShareGrantSnapshot,
  userId: string,
  nowMs: number,
): LaneShareGuestGrant[] {
  const serverNow = nowMs + snapshot.serverOffsetMs;
  return snapshot.grants
    .filter((grant) =>
      grant.state === "active"
      && grant.receiverUserId === userId
      && (grant.endsAt == null || grant.endsAt > serverNow))
    .map((grant) => ({
      grantId: grant.id,
      laneId: grant.laneId,
      // On the host clock, so each use can check it without the snapshot.
      endsAtMs: grant.endsAt == null ? null : grant.endsAt - snapshot.serverOffsetMs,
    }));
}

function parseGrant(value: unknown): LaneShareHostGrantRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && GRANT_ID.test(record.id) ? record.id : null;
  const laneId = typeof record.laneId === "string" && record.laneId.trim() ? record.laneId.trim() : null;
  const state = record.state === "active" || record.state === "pending" ? record.state : null;
  const receiverUserId = typeof record.receiverUserId === "string" && record.receiverUserId.trim()
    ? record.receiverUserId.trim()
    : null;
  const endsAt = typeof record.endsAt === "number" && Number.isFinite(record.endsAt) ? record.endsAt : null;
  if (!id || !laneId || !state) return null;
  if (record.endsAt != null && endsAt == null) return null;
  return { id, laneId, state, receiverUserId, endsAt };
}

/** The whole answer or nothing: one malformed grant rejects the list. */
export function parseLaneShareHostResponse(value: unknown): { serverTime: number; grants: LaneShareHostGrantRecord[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LaneShareGrantError("invalid_response", "The grant list was not an object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.serverTime !== "number" || !Number.isFinite(record.serverTime)) {
    throw new LaneShareGrantError("invalid_response", "The grant list had no server time.");
  }
  if (!Array.isArray(record.grants) || record.grants.length > MAX_GRANTS) {
    throw new LaneShareGrantError("invalid_response", "The grant list had no grants array.");
  }
  const grants: LaneShareHostGrantRecord[] = [];
  for (const entry of record.grants) {
    const grant = parseGrant(entry);
    if (!grant) throw new LaneShareGrantError("invalid_response", "The grant list had a malformed grant.");
    grants.push(grant);
  }
  return { serverTime: record.serverTime, grants };
}

export function createLaneShareGrantService(options: {
  /** The machine owner's account token; null when signed out. */
  getAccessToken: (tokenOptions?: { forceRefresh?: boolean }) => Promise<string | null>;
  /** The configured account-directory base URL (checked against the trusted list here). */
  getDirectoryBaseUrl: () => string | null | undefined;
  getMachineKey: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: { warn(event: string, fields?: Record<string, unknown>): void };
}): LaneShareGrantSource {
  const now = options.now ?? Date.now;
  let last: LaneShareGrantSnapshot | null = null;
  let inFlight: Promise<LaneShareGrantSnapshot> | null = null;
  const listeners = new Set<(snapshot: LaneShareGrantSnapshot) => void>();

  /**
   * One POST to the directory with the owner's token (one retry after a 401
   * with a refreshed token), answered as parsed JSON. `notFound` names the
   * error a 404 means for this route.
   */
  const post = async (path: string, body: Record<string, unknown>, notFound: LaneShareGrantError): Promise<unknown> => {
    let baseUrl: string | null = null;
    try {
      baseUrl = resolveTrustedAccountDirectoryBaseUrl(options.getDirectoryBaseUrl());
    } catch {
      baseUrl = null;
    }
    if (!baseUrl) throw new LaneShareGrantError("no_directory", "No trusted account directory is configured.");
    const machineKey = options.getMachineKey().trim();
    if (!machineKey) throw new LaneShareGrantError("unknown_machine", "This machine has no machine key.");
    let token: string | null;
    try {
      token = (await options.getAccessToken())?.trim() || null;
    } catch {
      token = null;
    }
    if (!token) throw new LaneShareGrantError("signed_out", "This machine is not signed in to an ADE account.");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    const correlationId = createAccountDirectoryCorrelationId();
    const send = (accessToken: string): Promise<Response> =>
      (options.fetchImpl ?? fetch)(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
          "x-ade-correlation-id": correlationId,
        },
        body: JSON.stringify({ ...body, machineKey }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    try {
      let response: Response;
      try {
        response = await send(token);
        if (response.status === 401) {
          await response.body?.cancel().catch(() => {});
          const refreshed = (await options.getAccessToken({ forceRefresh: true }).catch(() => null))?.trim();
          if (!refreshed) throw new LaneShareGrantError("signed_out", "The account session expired.");
          response = await send(refreshed);
        }
      } catch (error) {
        if (error instanceof LaneShareGrantError) throw error;
        throw new LaneShareGrantError("unavailable", "The account directory could not be reached.");
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        throw notFound;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        throw new LaneShareGrantError("signed_out", "The account directory refused this machine's session.");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new LaneShareGrantError("unavailable", `The account directory answered ${response.status}.`);
      }
      try {
        return await readBoundedAccountDirectoryJson(response);
      } catch {
        throw new LaneShareGrantError("invalid_response", "The directory answer could not be read.");
      }
    } finally {
      clearTimeout(timer);
    }
  };

  const toSnapshot = (list: { serverTime: number; grants: LaneShareHostGrantRecord[] }): LaneShareGrantSnapshot => {
    const fetchedAtMs = now();
    return { grants: list.grants, fetchedAtMs, serverOffsetMs: list.serverTime - fetchedAtMs };
  };

  const read = async (): Promise<LaneShareGrantSnapshot> => toSnapshot(parseLaneShareHostResponse(await post(
    "/lane-shares/host",
    {},
    new LaneShareGrantError("unknown_machine", "The account directory does not list this machine for this account."),
  )));

  const publish = (snapshot: LaneShareGrantSnapshot): void => {
    last = snapshot;
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        options.logger?.warn("lane_share.grant_listener_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const asGrantError = (error: unknown, fallback: string): LaneShareGrantError => {
    const failure = error instanceof LaneShareGrantError ? error : new LaneShareGrantError("unavailable", fallback);
    // A machine the directory no longer lists for this account has no grants: never reuse the old list.
    if (failure.code === "unknown_machine") last = null;
    return failure;
  };

  return {
    refresh(refreshOptions = {}) {
      const maxAgeMs = refreshOptions.maxAgeMs ?? 0;
      if (last && maxAgeMs > 0 && now() - last.fetchedAtMs <= maxAgeMs) return Promise.resolve(last);
      if (inFlight) return inFlight;
      const pending = read().then(
        (snapshot) => {
          publish(snapshot);
          return snapshot;
        },
        (error: unknown) => {
          const failure = asGrantError(error, "The grant list could not be read.");
          options.logger?.warn("lane_share.grant_refresh_failed", { code: failure.code });
          throw failure;
        },
      );
      inFlight = pending;
      void pending.finally(() => {
        if (inFlight === pending) inFlight = null;
      }).catch(() => {});
      return pending;
    },
    async redeem(ticket) {
      if (!TICKET.test(ticket)) throw new LaneShareGrantError("ticket_refused", "The ticket is malformed.");
      try {
        const answer = parseLaneShareRedeemResponse(await post(
          "/lane-shares/host/redeem",
          { ticket },
          new LaneShareGrantError("ticket_refused", "The account directory did not honor the ticket."),
        ));
        const snapshot = toSnapshot(answer.list);
        publish(snapshot);
        return { redemption: answer.redemption, snapshot };
      } catch (error) {
        const failure = asGrantError(error, "The ticket could not be redeemed.");
        options.logger?.warn("lane_share.ticket_redeem_failed", { code: failure.code });
        throw failure;
      }
    },
    current: () => last,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
