import type { CallerTokenEnv } from "../callerToken";
import type { ClerkAccountEnv } from "../laneShares/clerkAccount";
import { logGithubApp } from "../logging";
import {
  GITHUB_APP_CLIENT_SAFETY_SEC,
  GITHUB_APP_TOKEN_MARGIN_MS,
  type GithubAppNeedsReauthReason,
} from "./contract";
import {
  checkToken,
  deleteToken,
  githubBases,
  NON_EXPIRING_ACCESS_AT,
  refreshTokens,
  type GithubOAuthConfig,
  type GithubTokens,
  type GithubUser,
} from "./oauth";
import { grantAad, randomHex, seal, sha256Hex, signInTokensAad, tokenKey, unseal } from "./seal";

/**
 * The account's GitHub App grant: storage, and renewal with one writer.
 *
 * Renewal rule (spec 3.4, with the closing window below). `R` is
 * `access_expires_at - MARGIN` (20 min). A served token carries
 * `useForSec = R - now`, so every client stops at about `R - 30 s` (the
 * client's own safety). The Worker refreshes only at or after
 * `R - HOLD_AFTER_CLIENT_STOP` (`R - 15 s`), 15 s after every client stopped.
 * A request that arrives between `R - 30 s` and `R - 15 s` waits on the
 * Worker for the rest of that gap (at most 15 s) and then renews; without
 * that wait it would get a token with no time left and ask again in a loop.
 *
 * One writer: the request that finds the token due takes the lease with one
 * conditional update. The others read the row every 250 ms for up to 3 s,
 * then answer 503 `renewing`.
 */

export type GithubAppEnv = CallerTokenEnv & ClerkAccountEnv & {
  DB: D1Database;
  WEB_CLIENT_ORIGIN?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_TOKEN_KEY?: string;
  GITHUB_WEB_BASE_URL?: string;
  GITHUB_API_BASE_URL?: string;
};

export type GithubAppRuntime = {
  db: D1Database;
  key: CryptoKey;
  config: GithubOAuthConfig & { clientSecret: string };
};

/** Everything the routes need, or null when a secret or a setting is missing or malformed. */
export async function githubAppRuntime(env: GithubAppEnv): Promise<GithubAppRuntime | null> {
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  const bases = githubBases(env);
  if (!clientId || !clientSecret || !bases || !env.DB) return null;
  const key = await tokenKey(env.GITHUB_APP_TOKEN_KEY);
  if (!key) return null;
  return { db: env.DB, key, config: { clientId, clientSecret, ...bases } };
}

export type GrantRow = {
  user_id: string;
  github_user_id: number;
  github_login: string;
  access_token_sealed: string;
  access_token_sha256: string;
  access_expires_at: number;
  refresh_token_sealed: string | null;
  refresh_expires_at: number | null;
  origin: "web_flow" | "adopted_device_flow";
  state: "active" | "needs_reauth";
  state_reason: GithubAppNeedsReauthReason | null;
  generation: number;
  lease_id: string | null;
  lease_until: number | null;
  refresh_not_before: number | null;
  refresh_failures: number;
  last_rejected_check_at: number | null;
  created_at: number;
  updated_at: number;
};

const LEASE_MS = 45_000;
/** The Worker refreshes this long after the clients' shared stop time. */
const HOLD_AFTER_CLIENT_STOP_MS = 15_000;
const CLIENT_SAFETY_MS = GITHUB_APP_CLIENT_SAFETY_SEC * 1000;
const WAIT_POLL_MS = 250;
const WAIT_TOTAL_MS = 3_000;
/** How long a report of the live token's 401 waits for another request's check to settle. */
const REJECTED_WAIT_MS = 5_000;
const BACKOFF_MIN_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const PERSIST_ATTEMPTS = 3;
const REJECTED_CHECK_INTERVAL_MS = 60_000;
/** A degraded answer (GitHub down) never lasts longer than this. */
const DEGRADED_MAX_USE_MS = 5 * 60_000;
/** A degraded answer that would leave a client less than this is not worth giving. */
const DEGRADED_MIN_USE_MS = 60_000;
/** The longest `useForSec` for a token with no expiry, so a revoke is still seen within a working day. */
const NON_EXPIRING_MAX_USE_SEC = 8 * 60 * 60;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function loadGrant(db: D1Database, userId: string): Promise<GrantRow | null> {
  return await db.prepare("select * from github_app_grants where user_id = ?").bind(userId).first<GrantRow>() ?? null;
}

/** `R`: the clients' deadline plus their safety. */
const clientDeadlineBase = (row: { access_expires_at: number }): number => row.access_expires_at - GITHUB_APP_TOKEN_MARGIN_MS;
/** The earliest time the Worker may refresh this grant without killing a token a client still uses. */
const refreshAllowedAt = (row: { access_expires_at: number }): number => clientDeadlineBase(row) - HOLD_AFTER_CLIENT_STOP_MS;

function useForSecOf(accessExpiresAt: number, now: number): number {
  const seconds = Math.floor((clientDeadlineBase({ access_expires_at: accessExpiresAt }) - now) / 1000);
  return accessExpiresAt >= NON_EXPIRING_ACCESS_AT ? Math.min(seconds, NON_EXPIRING_MAX_USE_SEC) : seconds;
}

export type ServedToken = {
  accessToken: string;
  expiresAt: number;
  useForSec: number;
  githubLogin: string;
  githubUserId: number;
  generation: number;
  verified?: boolean;
  degraded?: boolean;
};

export type TokenOutcome =
  | { kind: "token"; token: ServedToken; reason: "current" | "refreshed" | "degraded" | "verified" | "unpersisted" }
  | { kind: "not_connected" }
  | { kind: "needs_reauth"; reason: GithubAppNeedsReauthReason }
  | { kind: "renewing"; retryAfterSec: number }
  | { kind: "unavailable"; retryAfterSec: number };

async function serveRow(rt: GithubAppRuntime, row: GrantRow, now: number, extra: Partial<ServedToken> = {}, useForSec?: number): Promise<ServedToken> {
  return {
    accessToken: await unseal(rt.key, row.access_token_sealed, grantAad(row.user_id, "access")),
    expiresAt: row.access_expires_at,
    useForSec: useForSec ?? useForSecOf(row.access_expires_at, now),
    githubLogin: row.github_login,
    githubUserId: row.github_user_id,
    generation: row.generation,
    ...extra,
  };
}

/**
 * `POST /github/app/token`. `rejectedSha256` is the client's hash of a token
 * GitHub answered 401 to.
 */
export async function serveToken(
  rt: GithubAppRuntime,
  userId: string,
  request: { rejectedSha256: string | null },
  now: number = Date.now(),
): Promise<TokenOutcome> {
  const row = await loadGrant(rt.db, userId);
  if (!row) return { kind: "not_connected" };
  if (row.state === "needs_reauth") return { kind: "needs_reauth", reason: row.state_reason ?? "bad_refresh_token" };

  if (request.rejectedSha256 && request.rejectedSha256 === row.access_token_sha256) {
    // The live token was refused. Ask GitHub at most once a minute per
    // account whether it is still valid; the claim is one conditional write,
    // so twenty clients reporting the same 401 make one check.
    const claim = await rt.db.prepare(`
      update github_app_grants set last_rejected_check_at = ?
      where user_id = ? and generation = ? and (last_rejected_check_at is null or last_rejected_check_at <= ?)
    `).bind(now, userId, row.generation, now - REJECTED_CHECK_INTERVAL_MS).run();
    if ((claim.meta?.changes ?? 0) === 1) {
      const accessToken = await unseal(rt.key, row.access_token_sealed, grantAad(userId, "access"));
      const check = await checkToken(rt.config, accessToken);
      logGithubApp({ event: "github_app.rejected_checked", userId, outcome: check.kind });
      if (check.kind === "valid") {
        return { kind: "token", token: await serveRow(rt, row, now, { verified: true }), reason: "verified" };
      }
      if (check.kind === "invalid") return renew(rt, row, now, { force: true });
    } else {
      // Another request checks (or checked) this token. Wait for its renewal
      // instead of handing back the token this client just saw refused; if
      // none comes, the check found it valid and it is served below.
      const settled = await waitForRenewal(rt, row, REJECTED_WAIT_MS);
      if (settled) return settled;
      now = Date.now();
    }
  }

  if (now < clientDeadlineBase(row) - CLIENT_SAFETY_MS) {
    return { kind: "token", token: await serveRow(rt, row, now), reason: "current" };
  }
  // The closing window: every client has stopped, but a refresh now could
  // still meet a request that is a few seconds late. Wait out the rest.
  const allowedAt = refreshAllowedAt(row);
  if (now < allowedAt) {
    await sleep(allowedAt - now);
    now = Date.now();
  }
  return renew(rt, row, now, { force: false });
}

/** Serve the old token for a short, safe time while GitHub is not answering, or say when to come back. */
async function degraded(rt: GithubAppRuntime, row: GrantRow, now: number): Promise<TokenOutcome> {
  const retryAt = Math.max(row.refresh_not_before ?? now, now);
  // A client stops at `now + use - 30 s`; the next refresh is at `retryAt`.
  // Keep 15 s between the two, and 90 s before GitHub's own expiry.
  const useMs = Math.min(retryAt - now + HOLD_AFTER_CLIENT_STOP_MS, row.access_expires_at - now - 90_000, DEGRADED_MAX_USE_MS);
  if (useMs >= DEGRADED_MIN_USE_MS) {
    return { kind: "token", token: await serveRow(rt, row, now, { degraded: true }, Math.floor(useMs / 1000)), reason: "degraded" };
  }
  return { kind: "unavailable", retryAfterSec: Math.max(1, Math.min(3600, Math.ceil((retryAt - now) / 1000))) };
}

async function markNeedsReauth(rt: GithubAppRuntime, row: GrantRow, reason: GithubAppNeedsReauthReason, now: number, leaseId: string | null): Promise<void> {
  await rt.db.prepare(`
    update github_app_grants set state = 'needs_reauth', state_reason = ?, lease_id = null, lease_until = null, updated_at = ?
    where user_id = ? and generation = ? and (? is null or lease_id = ?)
  `).bind(reason, now, row.user_id, row.generation, leaseId, leaseId).run();
  logGithubApp({ event: "github_app.needs_reauth", userId: row.user_id, reason, generation: row.generation });
}

/**
 * Refresh the grant under the lease. `force`: GitHub says the live token is
 * no longer valid, so the deadline does not apply.
 */
export async function renew(rt: GithubAppRuntime, row: GrantRow, now: number, options: { force: boolean }): Promise<TokenOutcome> {
  if (!row.refresh_token_sealed) {
    // A token with no expiry and no refresh token: nothing to renew.
    if (options.force) {
      await markNeedsReauth(rt, row, "revoked", now, null);
      return { kind: "needs_reauth", reason: "revoked" };
    }
    return { kind: "token", token: await serveRow(rt, row, now), reason: "current" };
  }
  if (row.refresh_expires_at != null && row.refresh_expires_at <= now) {
    await markNeedsReauth(rt, row, "refresh_expired", now, null);
    return { kind: "needs_reauth", reason: "refresh_expired" };
  }
  if (row.refresh_not_before != null && row.refresh_not_before > now) {
    return options.force ? { kind: "unavailable", retryAfterSec: Math.ceil((row.refresh_not_before - now) / 1000) } : degraded(rt, row, now);
  }

  // A lease left in the past means the last holder died mid-refresh. If
  // GitHub took that refresh, the stored refresh token is spent and the
  // answer below is `bad_refresh_token`; the reason then says why.
  const staleLease = row.lease_id != null && row.lease_until != null && row.lease_until <= now;
  const leaseId = randomHex(16);
  const take = await rt.db.prepare(`
    update github_app_grants set lease_id = ?, lease_until = ?
    where user_id = ? and generation = ? and state = 'active'
      and (lease_until is null or lease_until <= ?)
      and (refresh_not_before is null or refresh_not_before <= ?)
  `).bind(leaseId, now + LEASE_MS, row.user_id, row.generation, now, now).run();
  if ((take.meta?.changes ?? 0) !== 1) return (await waitForRenewal(rt, row)) ?? { kind: "renewing", retryAfterSec: 2 };

  let refreshToken: string;
  try {
    refreshToken = await unseal(rt.key, row.refresh_token_sealed, grantAad(row.user_id, "refresh"));
  } catch {
    // The key changed or the row was copied: the chain cannot be used.
    await markNeedsReauth(rt, row, "bad_refresh_token", now, leaseId);
    return { kind: "needs_reauth", reason: "bad_refresh_token" };
  }
  // A device-flow token refreshes with no client secret (GitHub docs); that
  // is the request the desktop has always sent for it.
  const config = row.origin === "adopted_device_flow" ? { ...rt.config, clientSecret: null } : rt.config;
  const result = await refreshTokens(config, refreshToken, Date.now());
  const after = Date.now();

  if (result.ok) {
    const persisted = await persistRefresh(rt, row, leaseId, result.tokens, after);
    if (persisted.kind === "saved") {
      const saved = persisted.row;
      logGithubApp({ event: "github_app.refreshed", userId: row.user_id, generation: saved.generation, forced: options.force });
      return { kind: "token", token: await serveRow(rt, saved, after), reason: "refreshed" };
    }
    if (persisted.kind === "replaced") {
      // A new sign-in or a disconnect replaced the row during the refresh:
      // this chain is no longer the account's. Its new token is deleted at
      // GitHub and never served; the caller gets what the account has now.
      await deleteToken(rt.config, result.tokens.accessToken);
      logGithubApp({ event: "github_app.refresh_replaced", userId: row.user_id, generation: row.generation });
      const current = await loadGrant(rt.db, row.user_id);
      if (!current) return { kind: "not_connected" };
      if (current.state === "needs_reauth") return { kind: "needs_reauth", reason: current.state_reason ?? "bad_refresh_token" };
      return { kind: "token", token: await serveRow(rt, current, after), reason: "current" };
    }
    // GitHub took the refresh but D1 did not save it. The caller gets the
    // working token only while the account still holds this chain: after a
    // disconnect or a new sign-in (or when D1 cannot even say) the new token
    // is deleted at GitHub, because no row is left to revoke it later. The
    // next refresh finds the stored refresh token spent and the grant goes to
    // needs_reauth with `unpersisted_refresh`.
    const owner = await loadGrant(rt.db, row.user_id).catch(() => undefined);
    // The update can commit while every read after it fails: then the row
    // already holds this token, and it is served, never deleted.
    if (owner && owner.access_token_sha256 === await sha256Hex(result.tokens.accessToken)) {
      logGithubApp({ event: "github_app.refreshed", userId: row.user_id, generation: owner.generation, forced: options.force });
      return { kind: "token", token: await serveRow(rt, owner, after), reason: "refreshed" };
    }
    if (!owner || owner.access_token_sha256 !== row.access_token_sha256) {
      await deleteToken(rt.config, result.tokens.accessToken);
      logGithubApp({ event: "github_app.refresh_unpersisted_dropped", userId: row.user_id, generation: row.generation + 1, ownerKnown: owner !== undefined });
      if (owner === null) return { kind: "not_connected" };
      return { kind: "unavailable", retryAfterSec: Math.ceil(BACKOFF_MIN_MS / 1000) };
    }
    logGithubApp({ event: "github_app.refresh_unpersisted", userId: row.user_id, generation: row.generation + 1 });
    return {
      kind: "token",
      reason: "unpersisted",
      token: {
        accessToken: result.tokens.accessToken,
        expiresAt: result.tokens.accessExpiresAt,
        useForSec: useForSecOf(result.tokens.accessExpiresAt, after),
        githubLogin: row.github_login,
        githubUserId: row.github_user_id,
        generation: row.generation + 1,
      },
    };
  }

  if (result.kind === "bad_refresh_token") {
    const reason: GithubAppNeedsReauthReason = staleLease ? "unpersisted_refresh" : options.force ? "revoked" : "bad_refresh_token";
    await markNeedsReauth(rt, row, reason, after, leaseId);
    return { kind: "needs_reauth", reason };
  }

  // 429, 5xx, network, a wrong client secret, or an error GitHub has not
  // documented: back off (1 min doubling to 1 h, or GitHub's retry-after if
  // longer) and keep the grant. Only `bad_refresh_token` ends it.
  const failures = row.refresh_failures + 1;
  const backoff = Math.min(BACKOFF_MAX_MS, Math.max(
    BACKOFF_MIN_MS * 2 ** Math.min(failures - 1, 10),
    result.kind === "transient" && result.retryAfterSec ? result.retryAfterSec * 1000 : 0,
  ));
  const notBefore = after + backoff;
  await rt.db.prepare(`
    update github_app_grants set lease_id = null, lease_until = null, refresh_not_before = ?, refresh_failures = ?, updated_at = ?
    where user_id = ? and lease_id = ?
  `).bind(notBefore, failures, after, row.user_id, leaseId).run();
  logGithubApp({
    event: "github_app.refresh_failed",
    userId: row.user_id,
    kind: result.kind,
    status: result.kind === "transient" ? result.status : undefined,
    oauthError: result.kind === "refused" || result.kind === "client_credentials" ? result.oauthError : undefined,
    backoffSec: Math.round(backoff / 1000),
  });
  if (options.force) return { kind: "unavailable", retryAfterSec: Math.ceil(backoff / 1000) };
  return degraded(rt, { ...row, refresh_not_before: notBefore, refresh_failures: failures }, after);
}

/**
 * `saved`: the row has the new chain. `replaced`: the lease is gone because a
 * new sign-in or a disconnect replaced the row. `failed`: D1 did not answer.
 */
type PersistOutcome = { kind: "saved"; row: GrantRow } | { kind: "replaced" } | { kind: "failed" };

async function persistRefresh(rt: GithubAppRuntime, row: GrantRow, leaseId: string, tokens: GithubTokens, now: number): Promise<PersistOutcome> {
  const accessSealed = await seal(rt.key, tokens.accessToken, grantAad(row.user_id, "access"));
  const accessHash = await sha256Hex(tokens.accessToken);
  // GitHub always sends a new refresh token; if one ever did not, the old
  // one is still the live one.
  const refreshSealed = tokens.refreshToken
    ? await seal(rt.key, tokens.refreshToken, grantAad(row.user_id, "refresh"))
    : row.refresh_token_sealed;
  const refreshExpiresAt = tokens.refreshToken ? tokens.refreshExpiresAt : row.refresh_expires_at;
  // The row is judged by its token hash, not by the update's change count: an
  // update that committed before its answer (or the read after it) was lost
  // finds the lease already cleared on the retry, yet the row holds this
  // token. Calling that `replaced` would delete the account's saved token.
  for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
    try {
      await rt.db.prepare(`
        update github_app_grants set
          access_token_sealed = ?, access_token_sha256 = ?, access_expires_at = ?,
          refresh_token_sealed = ?, refresh_expires_at = ?,
          generation = generation + 1, lease_id = null, lease_until = null,
          refresh_not_before = null, refresh_failures = 0, last_rejected_check_at = null, updated_at = ?
        where user_id = ? and lease_id = ?
      `).bind(accessSealed, accessHash, tokens.accessExpiresAt, refreshSealed, refreshExpiresAt, now, row.user_id, leaseId).run();
      const current = await loadGrant(rt.db, row.user_id);
      return current && current.access_token_sha256 === accessHash ? { kind: "saved", row: current } : { kind: "replaced" };
    } catch {
      if (attempt < PERSIST_ATTEMPTS - 1) await sleep(200 * (attempt + 1));
    }
  }
  return { kind: "failed" };
}

/**
 * Another request holds the lease (or checks the token): read the row until
 * the new generation (or a verdict) shows up. Null when nothing changed in
 * `totalMs`.
 */
async function waitForRenewal(rt: GithubAppRuntime, row: GrantRow, totalMs: number = WAIT_TOTAL_MS): Promise<TokenOutcome | null> {
  for (let waited = 0; waited < totalMs; waited += WAIT_POLL_MS) {
    await sleep(WAIT_POLL_MS);
    const now = Date.now();
    const current = await loadGrant(rt.db, row.user_id);
    if (!current) return { kind: "not_connected" };
    if (current.state === "needs_reauth") return { kind: "needs_reauth", reason: current.state_reason ?? "bad_refresh_token" };
    if (current.generation !== row.generation && now < clientDeadlineBase(current) - CLIENT_SAFETY_MS) {
      return { kind: "token", token: await serveRow(rt, current, now), reason: "refreshed" };
    }
    // The holder failed and backed off.
    if (current.lease_id == null && current.refresh_not_before != null && current.refresh_not_before > now) {
      return degraded(rt, current, now);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Saving a new grant (sign-in, adoption) and removing one

/**
 * Save a new token chain for the account. Returns the previous row so the
 * caller can delete its token at GitHub (decision C13).
 */
export async function saveGrant(
  rt: GithubAppRuntime,
  userId: string,
  user: GithubUser,
  tokens: GithubTokens,
  origin: GrantRow["origin"],
  now: number,
  options: { onlyIfNotActive?: boolean } = {},
): Promise<{ saved: GrantRow | null; previous: GrantRow | null }> {
  const previous = await loadGrant(rt.db, userId);
  if (options.onlyIfNotActive && previous?.state === "active") return { saved: null, previous };
  const accessSealed = await seal(rt.key, tokens.accessToken, grantAad(userId, "access"));
  const accessHash = await sha256Hex(tokens.accessToken);
  const refreshSealed = tokens.refreshToken ? await seal(rt.key, tokens.refreshToken, grantAad(userId, "refresh")) : null;
  const result = await rt.db.prepare(`
    insert into github_app_grants (
      user_id, github_user_id, github_login, access_token_sealed, access_token_sha256, access_expires_at,
      refresh_token_sealed, refresh_expires_at, origin, state, state_reason, generation,
      lease_id, lease_until, refresh_not_before, refresh_failures, last_rejected_check_at, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', null, 1, null, null, null, 0, null, ?, ?)
    on conflict(user_id) do update set
      github_user_id = excluded.github_user_id, github_login = excluded.github_login,
      access_token_sealed = excluded.access_token_sealed, access_token_sha256 = excluded.access_token_sha256,
      access_expires_at = excluded.access_expires_at, refresh_token_sealed = excluded.refresh_token_sealed,
      refresh_expires_at = excluded.refresh_expires_at, origin = excluded.origin, state = 'active', state_reason = null,
      generation = github_app_grants.generation + 1, lease_id = null, lease_until = null, refresh_not_before = null,
      refresh_failures = 0, last_rejected_check_at = null, created_at = excluded.created_at, updated_at = excluded.updated_at
    where ? = 0 or github_app_grants.state <> 'active'
  `).bind(
    userId, user.id, user.login, accessSealed, accessHash, tokens.accessExpiresAt,
    refreshSealed, tokens.refreshExpiresAt, origin, now, now, options.onlyIfNotActive ? 1 : 0,
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) return { saved: null, previous: await loadGrant(rt.db, userId) };
  return { saved: await loadGrant(rt.db, userId), previous };
}

/** Delete a previous row's access token at GitHub. Best effort: false when GitHub could not be reached. */
export async function deletePreviousToken(rt: GithubAppRuntime, previous: GrantRow | null, currentHash: string | null): Promise<boolean> {
  if (!previous || previous.access_token_sha256 === currentHash) return true;
  let accessToken: string;
  try {
    accessToken = await unseal(rt.key, previous.access_token_sealed, grantAad(previous.user_id, "access"));
  } catch {
    return false;
  }
  return deleteToken(rt.config, accessToken);
}

/** `DELETE /github/app/grant`: delete the token at GitHub, then the row. */
export async function removeGrant(rt: GithubAppRuntime, userId: string): Promise<{ existed: boolean; deletedAtGitHub: boolean }> {
  // Delete exactly the row that was read, so the token deleted at GitHub is
  // that row's. A renewal or a new sign-in between the read and the delete
  // changes the row; read it again and delete that one.
  for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
    const row = await loadGrant(rt.db, userId);
    if (!row) return { existed: false, deletedAtGitHub: true };
    const result = await rt.db
      .prepare("delete from github_app_grants where user_id = ? and access_token_sha256 = ? and generation = ?")
      .bind(userId, row.access_token_sha256, row.generation)
      .run();
    if ((result.meta?.changes ?? 0) === 1) return { existed: true, deletedAtGitHub: await deletePreviousToken(rt, row, null) };
  }
  // Still changing after every attempt: fail (the route answers 5xx) rather
  // than leave a token the caller believes is gone.
  throw new Error("github_app_grant_kept_changing");
}

/** How many times a disconnect reads and deletes the row while renewals change it. */
const REMOVE_ATTEMPTS = 3;

/**
 * Clerk `user.deleted`: delete the token at GitHub where the secrets allow
 * it (best effort), then every row of the account. Safe to repeat. A D1
 * failure throws, so the webhook answers 502 and Clerk delivers again.
 */
export async function deleteGithubAppAccount(env: GithubAppEnv, userId: string): Promise<void> {
  const rt = await githubAppRuntime(env).catch(() => null);
  if (rt) {
    const row = await loadGrant(env.DB, userId);
    if (row) await deletePreviousToken(rt, row, null).catch(() => false);
  }
  await env.DB.batch([
    env.DB.prepare("delete from github_app_grants where user_id = ?").bind(userId),
    env.DB.prepare("delete from github_app_sign_ins where user_id = ?").bind(userId),
    env.DB.prepare("delete from github_app_rate where user_id = ?").bind(userId),
  ]);
}

// ---------------------------------------------------------------------------
// Route limits

/**
 * Count one request in the account's current window. One write. Returns the
 * seconds to wait when the request is over the limit, else 0.
 */
export async function overLimit(db: D1Database, userId: string, bucket: string, limit: number, windowMs: number, now: number): Promise<number> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db.prepare(`
    insert into github_app_rate (user_id, bucket, window_start, count) values (?, ?, ?, 1)
    on conflict(user_id, bucket, window_start) do update set count = count + 1
    returning count
  `).bind(userId, bucket, windowStart).first<{ count: number }>();
  return (row?.count ?? 0) > limit ? Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)) : 0;
}

// ---------------------------------------------------------------------------
// The cron

const KEEPALIVE_WINDOW_MS = 30 * 24 * 60 * 60_000;
const KEEPALIVE_BATCH = 50;
const PRUNE_AFTER_MS = 24 * 60 * 60_000;
const PRUNE_BATCH = 500;
/** The minute of each hour the hourly work runs, and the hour (UTC) of the daily keepalive. */
const CRON_MINUTE = 17;
const KEEPALIVE_HOUR_UTC = 3;

const ABANDONED_CONFIRM_BATCH = 50;
/** A confirm that a stopped request left mid-save (`exchanging`, tokens held) is ended only this long after its expiry. */
const STUCK_CONFIRM_MARGIN_MS = 10 * 60_000;

/**
 * Hourly (minute 17): end each sign-in left on the confirm page past its
 * expiry (its token is deleted at GitHub), then delete sign-ins and rate
 * windows older than a day.
 * Daily (03:17 UTC): refresh up to 50 active grants whose refresh token ends
 * within 30 days and whose access token no client can still be using, so a
 * grant of an account whose machines are all off does not lapse. Every other
 * tick does nothing: no query.
 */
export async function runGithubAppCron(env: GithubAppEnv, tickTime: number = Date.now()): Promise<void> {
  // The tick's scheduled time picks the work (a late tick still counts as
  // its own minute); the work itself runs on the real clock.
  const date = new Date(tickTime);
  if (date.getUTCMinutes() !== CRON_MINUTE || !env.DB) return;
  const now = Date.now();
  const cutoff = now - PRUNE_AFTER_MS;
  await dropAbandonedConfirms(env, now);
  await env.DB.batch([
    env.DB.prepare("delete from github_app_sign_ins where id in (select id from github_app_sign_ins where created_at < ? limit ?)").bind(cutoff, PRUNE_BATCH),
    env.DB.prepare("delete from github_app_rate where rowid in (select rowid from github_app_rate where window_start < ? limit ?)").bind(cutoff, PRUNE_BATCH),
  ]);
  if (date.getUTCHours() !== KEEPALIVE_HOUR_UTC) return;
  await runGithubAppKeepalive(env, now);
}

/**
 * A sign-in that reached the confirm page and was never answered holds a
 * live GitHub token, sealed. Mark it expired (so the confirm form answers
 * "used") and delete that token at GitHub. The same for a confirm that a
 * request stopped in the middle of its save (`exchanging` with tokens held),
 * well after its expiry, so a save in progress is never cut off.
 */
async function dropAbandonedConfirms(env: GithubAppEnv, now: number): Promise<void> {
  const rt = await githubAppRuntime(env);
  if (!rt) return;
  // `expired` with tokens still held: an earlier sweep claimed the row but
  // could not finish (a failed read, GitHub not answering). The tokens stay
  // sealed on the row until the token is dealt with, so a later sweep retries.
  const due = await rt.db.prepare(`
    select id, user_id, status, tokens_sealed from github_app_sign_ins
    where tokens_sealed is not null
      and ((status = 'confirming' and expires_at <= ?) or (status = 'exchanging' and expires_at <= ?) or status = 'expired')
    limit ?
  `).bind(now, now - STUCK_CONFIRM_MARGIN_MS, ABANDONED_CONFIRM_BATCH)
    .all<{ id: string; user_id: string; status: string; tokens_sealed: string | null }>();
  const rows = due.results ?? [];
  const counts = { deletedAtGitHub: 0, unreadable: 0, kept: 0, retryLater: 0 };
  for (const row of rows) {
    try {
      const outcome = await dropAbandonedConfirm(rt, row);
      if (outcome) counts[outcome] += 1;
    } catch {
      counts.retryLater += 1;
    }
  }
  if (rows.length) logGithubApp({ event: "github_app.abandoned_confirms_dropped", userId: "cron", due: rows.length, ...counts });
}

/** Ends one abandoned confirm. Throws (tokens kept for the next sweep) when a read fails. */
async function dropAbandonedConfirm(
  rt: GithubAppRuntime,
  row: { id: string; user_id: string; status: string; tokens_sealed: string | null },
): Promise<"deletedAtGitHub" | "unreadable" | "kept" | "retryLater" | null> {
  // The claim ends the confirm (a late Connect now fails) but keeps the tokens.
  const claim = await rt.db.prepare(
    "update github_app_sign_ins set status = 'expired', confirm_hash = null where id = ? and status = ? and tokens_sealed is not null",
  ).bind(row.id, row.status).run();
  if ((claim.meta?.changes ?? 0) !== 1 || !row.tokens_sealed) return null;
  const clearTokens = (status: "expired" | "done") => rt.db.prepare(
    `update github_app_sign_ins set status = ?, ${status === "done" ? "result_code = 'ok', " : ""}tokens_sealed = null where id = ? and status = 'expired'`,
  ).bind(status, row.id).run();
  let tokens: GithubTokens;
  try {
    tokens = JSON.parse(await unseal(rt.key, row.tokens_sealed, signInTokensAad(row.id, row.user_id))) as GithubTokens;
  } catch {
    // Sealed under a key this Worker no longer has: no later sweep can read it either.
    await clearTokens("expired");
    return "unreadable";
  }
  // A confirm whose grant was saved but whose last write (marking it done)
  // failed: the account uses this token, so it is not deleted.
  const grant = await loadGrant(rt.db, row.user_id);
  if (grant && grant.access_token_sha256 === await sha256Hex(tokens.accessToken)) {
    await clearTokens("done");
    return "kept";
  }
  if (!(await deleteToken(rt.config, tokens.accessToken))) return "retryLater";
  await clearTokens("expired");
  return "deletedAtGitHub";
}

async function runGithubAppKeepalive(env: GithubAppEnv, now: number = Date.now()): Promise<{ due: number; refreshed: number }> {
  const rt = await githubAppRuntime(env);
  if (!rt) return { due: 0, refreshed: 0 };
  // `access_expires_at` bound: a refresh kills the old access token, so only
  // grants whose token no client may still use are renewed here.
  const due = await rt.db.prepare(`
    select * from github_app_grants
    where state = 'active' and refresh_expires_at is not null and refresh_expires_at < ?
      and access_expires_at <= ? and (refresh_not_before is null or refresh_not_before <= ?)
    order by refresh_expires_at limit ?
  `).bind(now + KEEPALIVE_WINDOW_MS, now + GITHUB_APP_TOKEN_MARGIN_MS - HOLD_AFTER_CLIENT_STOP_MS, now, KEEPALIVE_BATCH).all<GrantRow>();
  let refreshed = 0;
  for (const row of due.results ?? []) {
    const outcome = await renew(rt, row, now, { force: false });
    if (outcome.kind === "token" && outcome.reason === "refreshed") refreshed += 1;
  }
  if ((due.results ?? []).length) logGithubApp({ event: "github_app.keepalive", userId: "cron", due: (due.results ?? []).length, refreshed });
  return { due: (due.results ?? []).length, refreshed };
}
