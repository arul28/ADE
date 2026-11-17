import { ADE_LINEAR_APP_CLIENT_ID } from "../../../desktop/src/main/services/cto/linearAppClient";
import type { CloudWaitUntil } from "./analytics";
import { readVaultItem, relayFetch, writeVaultItem, type RelayEnv, type VaultRecord } from "./accountVault";
import { openJson, sealJson, userKeys } from "./seal";
import { logCloud, reportCloudFailure } from "./store";

/**
 * The directory renews a project's Linear OAuth grant when no computer does,
 * under the same "one owner renews, everyone else reads" protocol every
 * computer follows (desktop `account/rotatingCredentialOwner.ts`). The
 * directory is one more device, `LINEAR_DIRECTORY_OWNER`:
 *
 * 1. It renews only a grant that names ADE's own public (PKCE) client in its
 *    vault value (`clientId`). Computers write that field only when a sign-in
 *    or a refresh with that client succeeded. A grant without it, or with a
 *    person's own client (which can need a secret this server never has),
 *    stays with the computers: `linear_needs_renewal`.
 * 2. Lease: it claims the item (rewrites the same value with itself as
 *    `refreshOwner`, conditional on the revision it read) only when the owner
 *    has gone quiet (`LEASE_GRACE_MS` past both expiry and the last write) or
 *    there is no owner. It exchanges only after its claim stood for
 *    `LEASE_SETTLE_MS` and the item is still its claim, unchanged.
 * 3. Durable: the renewed grant is sealed into `cloud_linear_renewals` before
 *    it is published, and stays there until the vault has it. The publish is
 *    conditional on the lease revision; the minute cron retries a publish that
 *    did not go through, over the relay's narrow lease route, which replaces
 *    the item only while it still holds the spent refresh token.
 * 4. It never deletes the vault item. A dead grant (`invalid_grant`) is left
 *    for a computer, which owns that decision.
 *
 * A Worker's `waitUntil` runs about 30 s after the response, and the claim
 * must stand 30 s, so the steps are split over requests: one request claims,
 * a request at least 30 s later exchanges and publishes. Meanwhile each
 * request answers `linear_renewing`. Tokens live in memory, in the sealed row,
 * and in the vault only; nothing about them is logged.
 */

/** The directory's device id in the vault (`refreshOwner`, `writer_device_id`). */
export const LINEAR_DIRECTORY_OWNER = "ade-cloud-directory";
/** `ROTATING_OWNER_TAKEOVER_GRACE_MS`. */
const LEASE_GRACE_MS = 10 * 60_000;
/** `ROTATING_CLAIM_SETTLE_MS`. */
const LEASE_SETTLE_MS = 30_000;
/** An exchange that started this long ago and never finished is tried again. */
const EXCHANGE_STUCK_MS = 2 * 60_000;
/** Exchanges that fail for a reason other than a dead grant, before the directory lets go. */
const MAX_FAILURES = 3;
/** A claim nobody came back for (no request after it) is dropped after this long. */
const CLAIM_FORGOTTEN_MS = 24 * 60 * 60_000;
/** A token this close to its expiry is treated as expired (`LINEAR_EXPIRY_MARGIN_MS` in integrations.ts). */
const EXPIRY_MARGIN_MS = 60_000;
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_TOKEN_TIMEOUT_MS = 8_000;
const CRON_BATCH = 20;
const ITEM = { kind: "integration", key: "linear" } as const;

export type LinearRenewalEnv = RelayEnv & {
  /** "0" turns the directory's renewal off: expired grants then answer `linear_needs_renewal` as before. */
  CLOUD_LINEAR_RENEWAL?: string;
};

/** The vault value of a Linear OAuth connection (`encodeLinearAccountCredential` in linearAccountSync.ts). */
export type LinearGrant = {
  v: 1;
  authMode: "oauth";
  token: string;
  refreshToken: string;
  expiresAt: string | null;
  clientId: string;
};

type Pending = { grant: LinearGrant; spentRefreshToken: string };

type RenewalRow = {
  state: "claimed" | "exchanging" | "publish";
  lease_revision: string;
  claimed_at: number;
  attempt_at: number | null;
  failures: number;
  sealed_grant: string | null;
};

export type LinearRenewal = { ok: true; grant: LinearGrant } | "renewing" | "needs_renewal";

function grantOf(raw: string | null | undefined): LinearGrant | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || parsed.v !== 1 || parsed.authMode !== "oauth") return null;
    const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
    const token = text(parsed.token);
    const refreshToken = text(parsed.refreshToken);
    const clientId = text(parsed.clientId);
    if (!token || !refreshToken || !clientId) return null;
    return { v: 1, authMode: "oauth", token, refreshToken, expiresAt: text(parsed.expiresAt) || null, clientId };
  } catch {
    return null;
  }
}

const usable = (grant: LinearGrant, now: number): boolean => {
  const expiresAt = grant.expiresAt ? Date.parse(grant.expiresAt) : NaN;
  return !Number.isFinite(expiresAt) || expiresAt > now + EXPIRY_MARGIN_MS;
};

const sealAad = (userId: string, scope: string): string => `ade.cloud.linear-renewal.v1\0${userId}\0${scope}`;

function enabled(env: LinearRenewalEnv): boolean {
  return env.CLOUD_LINEAR_RENEWAL?.trim() !== "0"
    && Boolean(env.CLOUD_CHAT_MASTER_KEY?.trim())
    && Boolean(env.DIRECTORY_AUTH_SECRET?.trim())
    && relayFetch(env) !== null;
}

/** Who renews, as `rotatingRenewalRole` decides it for a device. */
function leaseRole(item: VaultRecord, grant: LinearGrant, now: number): "renew" | "claim" | "read" {
  const owner = item.refreshOwner?.trim() || "";
  if (owner === LINEAR_DIRECTORY_OWNER) return "renew";
  if (!owner) return "claim";
  const expiresAt = grant.expiresAt ? Date.parse(grant.expiresAt) : NaN;
  if (!Number.isFinite(expiresAt)) return "read";
  const updatedAt = Date.parse(item.updatedAt);
  return now > Math.max(expiresAt, Number.isFinite(updatedAt) ? updatedAt : Number.NEGATIVE_INFINITY) + LEASE_GRACE_MS ? "claim" : "read";
}

const readRow = (env: RelayEnv, userId: string, scope: string) => env.DB.prepare(
  "select state, lease_revision, claimed_at, attempt_at, failures, sealed_grant from cloud_linear_renewals where user_id = ? and scope = ?",
).bind(userId, scope).first<RenewalRow>();

const dropRow = (env: RelayEnv, userId: string, scope: string) => env.DB.prepare(
  "delete from cloud_linear_renewals where user_id = ? and scope = ?",
).bind(userId, scope).run();

async function openPending(env: RelayEnv, userId: string, scope: string, sealed: string | null, now: number): Promise<Pending | null> {
  const keys = await userKeys(env, userId, now);
  if (!keys) return null;
  const opened = await openJson(keys, sealAad(userId, scope), sealed) as { grant?: unknown; spentRefreshToken?: unknown } | undefined;
  const grant = grantOf(opened?.grant ? JSON.stringify(opened.grant) : null);
  const spent = typeof opened?.spentRefreshToken === "string" ? opened.spentRefreshToken : "";
  return grant && spent ? { grant, spentRefreshToken: spent } : null;
}

/**
 * For a Linear request whose stored OAuth token has run out (`item` is the
 * project's vault item as just read). A renewed grant still waiting for its
 * publish is used at once; otherwise this takes the next lease step in
 * `waitUntil` and the request answers `renewing`.
 */
export async function renewLinearGrant(env: LinearRenewalEnv, args: {
  authorization: string;
  userId: string;
  scope: string;
  item: VaultRecord;
  now: number;
  waitUntil: CloudWaitUntil;
}): Promise<LinearRenewal> {
  const { userId, scope, item, now } = args;
  const grant = grantOf(item.value);
  if (!grant || grant.clientId !== ADE_LINEAR_APP_CLIENT_ID || !enabled(env) || !args.waitUntil) return "needs_renewal";
  const waitUntil = args.waitUntil;
  const step = (event: string, work: () => Promise<unknown>) => waitUntil(work().catch((error: unknown) => {
    reportCloudFailure(event, { error: error instanceof Error ? error.name : "unknown" });
  }));

  const row = await readRow(env, userId, scope);
  if (row?.state === "publish") {
    const pending = await openPending(env, userId, scope, row.sealed_grant, now);
    if (pending && pending.spentRefreshToken === grant.refreshToken) {
      step("cloud.linear_renewal_publish_failed", () => publishWithBearer(env, args.authorization, userId, scope, pending, item.updatedAt));
      return usable(pending.grant, now) ? { ok: true, grant: pending.grant } : "renewing";
    }
    // The vault moved past the grant this row renewed from (a new sign-in) or the row can't be opened: it is not the grant to publish.
    if (pending) {
      await dropRow(env, userId, scope);
      logCloud("cloud.linear_renewal_superseded", { userId });
    } else {
      return "needs_renewal";
    }
  }

  const role = leaseRole(item, grant, now);
  if (role === "read") return "renewing";
  if (role === "claim") {
    step("cloud.linear_lease_claim_failed", () => claim(env, args.authorization, userId, scope, item));
    return "renewing";
  }
  const leaseStart = row && row.lease_revision === item.updatedAt ? row.claimed_at : Date.parse(item.updatedAt);
  if (!Number.isFinite(leaseStart) || now - leaseStart < LEASE_SETTLE_MS) return "renewing";
  step("cloud.linear_renewal_failed", () => exchange(env, args.authorization, userId, scope, item, grant, Number(leaseStart)));
  return "renewing";
}

/** Take the lease: the same value, with the directory as its owner, only if the item is still the revision read. */
async function claim(env: LinearRenewalEnv, authorization: string, userId: string, scope: string, item: VaultRecord): Promise<void> {
  if (!item.value) return;
  const written = await writeVaultItem(env, authorization, {
    scope, ...ITEM, value: item.value, ifRevision: item.updatedAt, refreshOwner: LINEAR_DIRECTORY_OWNER,
  }, LINEAR_DIRECTORY_OWNER);
  if (written !== "ok") return;
  const reread = await readVaultItem(env, authorization, { scope, ...ITEM });
  const after = reread.ok ? reread.value : null;
  if (!after || after.refreshOwner !== LINEAR_DIRECTORY_OWNER || after.value !== item.value) return;
  const at = Date.now();
  // Never over a row that holds a renewed grant (`publish`).
  await env.DB.prepare(`
    insert into cloud_linear_renewals (user_id, scope, state, lease_revision, claimed_at, attempt_at, failures, sealed_grant, updated_at)
    values (?, ?, 'claimed', ?, ?, null, 0, null, ?)
    on conflict (user_id, scope) do update set
      state = 'claimed', lease_revision = excluded.lease_revision, claimed_at = excluded.claimed_at,
      attempt_at = null, failures = 0, sealed_grant = null, updated_at = excluded.updated_at
    where cloud_linear_renewals.state != 'publish'
  `).bind(userId, scope, after.updatedAt, at, at).run();
  logCloud("cloud.linear_lease_claimed", { userId });
}

type TokenAnswer = { ok: true; accessToken: string; refreshToken: string | null; expiresIn: number | null } | { ok: false; invalidGrant: boolean; status: number };

async function exchangeAtLinear(grant: LinearGrant): Promise<TokenAnswer> {
  let response: Response;
  try {
    response = await fetch(LINEAR_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: grant.refreshToken, client_id: grant.clientId }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(LINEAR_TOKEN_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, invalidGrant: false, status: 0 };
  }
  const payload = await response.json().catch(() => ({})) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown };
  if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token.trim()) {
    // Only `invalid_grant` says the refresh token itself is dead (RFC 6749 §5.2).
    return { ok: false, invalidGrant: payload.error === "invalid_grant", status: response.status };
  }
  return {
    ok: true,
    accessToken: payload.access_token.trim(),
    refreshToken: typeof payload.refresh_token === "string" && payload.refresh_token.trim() ? payload.refresh_token.trim() : null,
    expiresIn: typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : null,
  };
}

/** Exchange the refresh token under the settled lease, seal the result, then publish it. */
async function exchange(env: LinearRenewalEnv, authorization: string, userId: string, scope: string, item: VaultRecord, grant: LinearGrant, leaseStart: number): Promise<void> {
  const now = Date.now();
  // The directory's own last publish is its lease too: give it a row to lock.
  await env.DB.prepare(`
    insert into cloud_linear_renewals (user_id, scope, state, lease_revision, claimed_at, attempt_at, failures, sealed_grant, updated_at)
    values (?, ?, 'claimed', ?, ?, null, 0, null, ?)
    on conflict (user_id, scope) do update set
      state = 'claimed', lease_revision = excluded.lease_revision, claimed_at = excluded.claimed_at,
      attempt_at = null, failures = 0, sealed_grant = null, updated_at = excluded.updated_at
    where cloud_linear_renewals.state != 'publish' and cloud_linear_renewals.lease_revision != excluded.lease_revision
  `).bind(userId, scope, item.updatedAt, leaseStart, now).run();
  // One exchange per lease, even when requests race: the row's own `where` takes it.
  const locked = await env.DB.prepare(`
    update cloud_linear_renewals set state = 'exchanging', attempt_at = ?, updated_at = ?
    where user_id = ? and scope = ? and lease_revision = ?
      and (state = 'claimed' or (state = 'exchanging' and attempt_at < ?))
  `).bind(now, now, userId, scope, item.updatedAt, now - EXCHANGE_STUCK_MS).run();
  if ((locked.meta?.changes ?? 0) === 0) return;

  const keys = await userKeys(env, userId, now);
  const fresh = await readVaultItem(env, authorization, { scope, ...ITEM });
  const current = fresh.ok ? fresh.value : null;
  if (!keys || !current || current.refreshOwner !== LINEAR_DIRECTORY_OWNER || current.updatedAt !== item.updatedAt || current.value !== item.value) {
    // The lease moved (another device wrote) or nothing can be kept durably: let go without spending the token.
    await dropRow(env, userId, scope);
    logCloud("cloud.linear_lease_lost", { userId, reason: keys ? "moved" : "no_key" });
    return;
  }

  const answer = await exchangeAtLinear(grant);
  if (!answer.ok) {
    if (answer.invalidGrant) {
      // Dead at Linear. The vault item stays: a computer that owns it decides.
      await dropRow(env, userId, scope);
      logCloud("cloud.linear_renewal_invalid_grant", { userId });
      return;
    }
    await env.DB.prepare(`
      update cloud_linear_renewals set state = 'claimed', failures = failures + 1, updated_at = ?
      where user_id = ? and scope = ? and state = 'exchanging'
    `).bind(Date.now(), userId, scope).run();
    await env.DB.prepare("delete from cloud_linear_renewals where user_id = ? and scope = ? and failures >= ?").bind(userId, scope, MAX_FAILURES).run();
    logCloud("cloud.linear_renewal_refused", { userId, status: answer.status });
    return;
  }

  const renewed: LinearGrant = {
    v: 1,
    authMode: "oauth",
    token: answer.accessToken,
    refreshToken: answer.refreshToken ?? grant.refreshToken,
    expiresAt: answer.expiresIn !== null ? new Date(Date.now() + answer.expiresIn * 1000).toISOString() : null,
    clientId: grant.clientId,
  };
  const pending: Pending = { grant: renewed, spentRefreshToken: grant.refreshToken };
  try {
    // Durable first: until the vault has it, this row is the only copy of the new refresh token.
    await env.DB.prepare(`
      update cloud_linear_renewals set state = 'publish', sealed_grant = ?, failures = 0, updated_at = ?
      where user_id = ? and scope = ?
    `).bind(await sealJson(keys, sealAad(userId, scope), pending), Date.now(), userId, scope).run();
  } catch (error) {
    reportCloudFailure("cloud.linear_renewal_seal_failed", { error: error instanceof Error ? error.name : "unknown" });
  }
  await publishWithBearer(env, authorization, userId, scope, pending, item.updatedAt);
}

/** Publish a renewed grant with the person's token, conditional on the lease revision. */
async function publishWithBearer(env: LinearRenewalEnv, authorization: string, userId: string, scope: string, pending: Pending, revision: string): Promise<void> {
  const value = JSON.stringify(pending.grant);
  const write = (ifRevision: string) => writeVaultItem(env, authorization, {
    scope, ...ITEM, value, ifRevision, refreshOwner: LINEAR_DIRECTORY_OWNER,
  }, LINEAR_DIRECTORY_OWNER);
  let written = await write(revision);
  if (written === "stale") {
    // Another device wrote since the lease. Replace it only while it still holds the spent grant (a takeover claim of it).
    const reread = await readVaultItem(env, authorization, { scope, ...ITEM });
    if (!reread.ok) return;
    const current = reread.value;
    if (!current || current.deleted || grantOf(current.value)?.refreshToken !== pending.spentRefreshToken) {
      await dropRow(env, userId, scope);
      logCloud("cloud.linear_renewal_superseded", { userId });
      return;
    }
    written = await write(current.updatedAt);
  }
  if (written !== "ok") return;
  await env.DB.prepare("delete from cloud_linear_renewals where user_id = ? and scope = ? and state = 'publish'").bind(userId, scope).run();
  logCloud("cloud.linear_renewed", { userId });
}

/**
 * Minute cron: publish renewed grants a request could not, over the relay's
 * lease route (directory secret, no account token); retry stuck exchanges;
 * drop claims nobody came back for.
 */
export async function runLinearRenewalCron(env: LinearRenewalEnv, now: number): Promise<void> {
  await env.DB.prepare(`
    update cloud_linear_renewals set state = 'claimed', updated_at = ?
    where state = 'exchanging' and attempt_at < ?
  `).bind(now, now - EXCHANGE_STUCK_MS).run();
  await env.DB.prepare("delete from cloud_linear_renewals where state = 'claimed' and updated_at < ?").bind(now - CLAIM_FORGOTTEN_MS).run();
  const relay = relayFetch(env);
  const secret = env.DIRECTORY_AUTH_SECRET?.trim();
  if (!relay || !secret) return;
  const rows = (await env.DB.prepare(`
    select user_id, scope, sealed_grant from cloud_linear_renewals
    where state = 'publish' and updated_at < ?
    order by updated_at limit ?
  `).bind(now - LEASE_SETTLE_MS, CRON_BATCH).all<{ user_id: string; scope: string; sealed_grant: string | null }>()).results ?? [];
  for (const row of rows) {
    const pending = await openPending(env, row.user_id, row.scope, row.sealed_grant, now);
    if (!pending) continue;
    let response: Response;
    try {
      response = await relay.fetch(`${relay.base}/directory/accounts/${encodeURIComponent(row.user_id)}/vault/linear-lease`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-ade-directory-auth": secret },
        body: JSON.stringify({ scope: row.scope, refreshOwner: LINEAR_DIRECTORY_OWNER, spentRefreshToken: pending.spentRefreshToken, value: JSON.stringify(pending.grant) }),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      logCloud("cloud.linear_renewal_publish_failed", { userId: row.user_id, error: error instanceof Error ? error.name : "unknown" });
      continue;
    }
    const body = await response.json().catch(() => null) as { ok?: unknown; written?: unknown } | null;
    if (!response.ok || body?.ok !== true || typeof body.written !== "number") {
      // An older relay (404) or a passing failure: the row stays for the next minute.
      await env.DB.prepare("update cloud_linear_renewals set updated_at = ? where user_id = ? and scope = ? and state = 'publish'").bind(now, row.user_id, row.scope).run();
      logCloud("cloud.linear_renewal_publish_failed", { userId: row.user_id, status: response.status });
      continue;
    }
    // Written, or nothing holds the spent grant any more (deleted, or a new sign-in): either way this row is done.
    await env.DB.prepare("delete from cloud_linear_renewals where user_id = ? and scope = ? and state = 'publish' and sealed_grant = ?").bind(row.user_id, row.scope, row.sealed_grant).run();
    logCloud(body.written > 0 ? "cloud.linear_renewed" : "cloud.linear_renewal_superseded", { userId: row.user_id, via: "cron" });
  }
}
