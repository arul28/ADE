/**
 * One owner renews, everyone else reads.
 *
 * A rotating OAuth grant (an MCP server's sign-in, a Linear connection) hands
 * back a new refresh token on every exchange, and a server that rotates treats
 * a second use of the old one as a replay and can revoke the whole grant. The
 * account vault copies the grant onto every machine, so every machine would
 * otherwise be one timer tick away from renewing it at the same moment.
 *
 * The vault item's `refreshOwner` names the one machine allowed to renew. That
 * machine publishes each fresh token back to the vault; the others read it and
 * never exchange. When the owner goes quiet (the token ran out and nothing new
 * arrived for `ROTATING_OWNER_TAKEOVER_GRACE_MS`), another machine takes over
 * by rewriting the item with its own device id, waits for that claim to stand
 * (`ROTATING_CLAIM_SETTLE_MS`), and only then renews.
 *
 * Within one machine the desktop app and the brain share a device id, so the
 * renewal itself also runs under a machine-local file lock
 * (`withCredentialRenewalLock`).
 */

import type { AccountVaultItem, AccountVaultResult, AccountVaultWriteOptions } from "../../../shared/types/accountVault";
import { describeVaultFailure } from "./vaultWrite";

/**
 * How long past expiry a token may sit un-renewed before another machine takes
 * over. MCP owners start renewing 15 minutes before expiry and look every 5
 * minutes, so an owner that has not published 10 minutes after expiry has
 * missed five chances: it is asleep, offline, or gone.
 */
const ROTATING_OWNER_TAKEOVER_GRACE_MS = 10 * 60 * 1000;
/**
 * How long a claim has to stand before its machine renews. Two machines can
 * claim the same stale grant in the same instant; the vault keeps the later
 * write, and this wait lets the earlier claimant see that before it exchanges.
 */
export const ROTATING_CLAIM_SETTLE_MS = 30 * 1000;
/** How fresh the vault's view must be before deciding who renews. */
const ROTATING_VAULT_FRESH_MS = 30 * 1000;

/** The vault calls the protocol needs; the desktop bridge and the brain store both fit. */
export type RotatingCredentialVault = {
  list(scope?: string | null): Promise<AccountVaultResult<AccountVaultItem[]>>;
  get(scope: string, kind: string, key: string): Promise<AccountVaultResult<string | null>>;
  set(
    scope: string,
    kind: string,
    key: string,
    value: string,
    options?: AccountVaultWriteOptions,
  ): Promise<AccountVaultResult<null>>;
  sync?(options?: { maxAgeMs?: number }): Promise<AccountVaultResult<unknown>>;
};

export type RotatingCredentialRef = { scope: string; kind: string; key: string };

export type RotatingRenewalRole = "renew" | "claim" | "read";

/**
 * Who renews, from the vault item's owner and the token's expiry.
 *
 * No device id means this computer has never joined sync: the grant cannot be
 * on another machine, so it renews as before. No owner (an item written before
 * owners existed, or by an older ADE) is claimed first, never renewed outright.
 *
 * An owner has gone quiet when the grace has passed since both the token's
 * expiry and the item's last write. The last write counts because a takeover
 * rewrites the item without making the token any less expired: without it a
 * third machine would find the new owner already stale and claim again.
 */
export function rotatingRenewalRole(args: {
  deviceId: string | null | undefined;
  owner: string | null | undefined;
  expiresAtMs: number | null;
  /** When the vault item was last written (its owner's claim or publish). */
  updatedAtMs?: number | null;
  nowMs: number;
  graceMs?: number;
}): RotatingRenewalRole {
  const deviceId = args.deviceId?.trim() || "";
  if (!deviceId) return "renew";
  const owner = args.owner?.trim() || "";
  if (!owner) return "claim";
  if (owner === deviceId) return "renew";
  const graceMs = args.graceMs ?? ROTATING_OWNER_TAKEOVER_GRACE_MS;
  if (args.expiresAtMs === null || !Number.isFinite(args.expiresAtMs)) return "read";
  const updatedAtMs = args.updatedAtMs !== null && args.updatedAtMs !== undefined && Number.isFinite(args.updatedAtMs)
    ? args.updatedAtMs
    : Number.NEGATIVE_INFINITY;
  return args.nowMs > Math.max(args.expiresAtMs, updatedAtMs) + graceMs ? "claim" : "read";
}

export type RotatingRenewalVerdict =
  | { renew: true; shared: boolean }
  | { renew: false; reason: "other_owner" | "claimed" | "claim_settling" | "claim_lost" | "claim_failed" };

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
} | null | undefined;

function findItem(items: AccountVaultItem[], ref: RotatingCredentialRef): AccountVaultItem | null {
  return items.find((item) => item.scope === ref.scope && item.kind === ref.kind && item.key === ref.key) ?? null;
}

type VaultWarn = (event: string, detail: unknown) => void;

async function syncQuietly(vault: RotatingCredentialVault, warn: VaultWarn, maxAgeMs?: number): Promise<void> {
  if (!vault.sync) return;
  try {
    await vault.sync(maxAgeMs === undefined ? undefined : { maxAgeMs });
  } catch (error) {
    // A sync that cannot run leaves the cached view, which is still an answer.
    warn("account_vault.rotating_sync_failed", error);
  }
}

async function readItem(vault: RotatingCredentialVault, ref: RotatingCredentialRef, warn: VaultWarn): Promise<AccountVaultItem | null | "unavailable"> {
  try {
    const listed = await vault.list(ref.scope);
    if (!listed.ok) {
      warn("account_vault.rotating_read_failed", listed);
      return "unavailable";
    }
    return findItem(listed.value, ref);
  } catch (error) {
    warn("account_vault.rotating_read_failed", error);
    return "unavailable";
  }
}

/**
 * Decide whether this machine may renew one vaulted grant now, claiming it
 * first when its owner is missing or has gone quiet.
 *
 * `currentValue` is what a claim re-publishes: the vault needs a value to carry
 * the new owner, and it must be the value the vault already holds.
 * `shared: false` on a "renew" verdict means this machine cannot coordinate
 * with the others: no vault, no sync identity, a vault that did not answer, or
 * no such item. A caller that already knows the grant is shared still
 * publishes what it renews, so the other machines do not keep a spent token.
 */
export async function decideRotatingRenewal(args: {
  vault: RotatingCredentialVault | null | undefined;
  deviceId: string | null | undefined;
  ref: RotatingCredentialRef;
  expiresAtMs: number | null;
  currentValue: string;
  nowMs?: number;
  /**
   * How long past expiry before a claim (default 10 min). The sign-in sync's
   * gate on a cloud computer passes 60 s (P5 §5.3); MCP and Linear keep the
   * default.
   */
  graceMs?: number;
  /**
   * What the claim writes, when it is not `currentValue` (default). The
   * sign-in sync's claim back drops a field that only the old owner needed
   * (step 3c). The check against the vault still compares `currentValue`.
   */
  claimValue?: string;
  logger?: Logger;
  logContext?: Record<string, unknown>;
}): Promise<RotatingRenewalVerdict> {
  const deviceId = args.deviceId?.trim() || "";
  const vault = args.vault ?? null;
  // No vault or no sync identity: nothing else can hold this grant.
  if (!vault || !deviceId) return { renew: true, shared: false };
  const now = () => args.nowMs ?? Date.now();
  const warn: VaultWarn = (event, detail) => args.logger?.warn?.(event, { ...args.logContext, error: describeVaultFailure(detail) });

  await syncQuietly(vault, warn, ROTATING_VAULT_FRESH_MS);
  const item = await readItem(vault, args.ref, warn);
  // A vault that cannot answer keeps the old single-machine behaviour; the
  // machine-local lock still keeps this computer's processes apart.
  if (item === "unavailable") return { renew: true, shared: false };
  if (!item || item.deleted === true) return { renew: true, shared: false };

  const role = rotatingRenewalRole({
    deviceId,
    owner: item.refreshOwner,
    expiresAtMs: args.expiresAtMs,
    updatedAtMs: Date.parse(item.updatedAt),
    nowMs: now(),
    graceMs: args.graceMs,
  });
  if (role === "read") return { renew: false, reason: "other_owner" };
  if (role === "renew") {
    // A claim (this process's or a sibling's on this machine) still settling.
    // A token this machine published moments ago lands here too, and waiting
    // half a minute to renew a token that fresh costs nothing.
    const updatedAtMs = Date.parse(item.updatedAt);
    if (item.refreshOwner?.trim() === deviceId && Number.isFinite(updatedAtMs) && now() - updatedAtMs < ROTATING_CLAIM_SETTLE_MS) {
      return { renew: false, reason: "claim_settling" };
    }
    return { renew: true, shared: true };
  }

  // Claim: look at the newest view first, so a fresh token the owner just
  // published is read rather than overwritten by this machine's stale copy.
  await syncQuietly(vault, warn);
  const latest = await readItem(vault, args.ref, warn);
  if (latest === "unavailable" || !latest || latest.deleted === true) return { renew: false, reason: "claim_failed" };
  const latestRole = rotatingRenewalRole({
    deviceId,
    owner: latest.refreshOwner,
    expiresAtMs: args.expiresAtMs,
    updatedAtMs: Date.parse(latest.updatedAt),
    nowMs: now(),
    graceMs: args.graceMs,
  });
  if (latestRole === "read") return { renew: false, reason: "other_owner" };
  let latestValue: string | null = null;
  try {
    const got = await vault.get(args.ref.scope, args.ref.kind, args.ref.key);
    latestValue = got.ok ? got.value : null;
  } catch (error) {
    warn("account_vault.rotating_read_failed", error);
    latestValue = null;
  }
  // The value moved under us: somebody published. Read it next time.
  if (latestValue !== args.currentValue) return { renew: false, reason: "claim_lost" };
  try {
    const written = await vault.set(args.ref.scope, args.ref.kind, args.ref.key, args.claimValue ?? args.currentValue, { refreshOwner: deviceId });
    if (!written.ok) {
      args.logger?.warn?.("account_vault.rotating_claim_failed", { ...args.logContext, error: describeVaultFailure(written) });
      return { renew: false, reason: "claim_failed" };
    }
  } catch (error) {
    args.logger?.warn?.("account_vault.rotating_claim_failed", { ...args.logContext, error: describeVaultFailure(error) });
    return { renew: false, reason: "claim_failed" };
  }
  await syncQuietly(vault, warn);
  args.logger?.info?.("account_vault.rotating_claimed", {
    ...args.logContext,
    previousOwner: latest.refreshOwner ? "other" : "none",
  });
  return { renew: false, reason: "claimed" };
}
