import { verifyCallerToken, type CallerTokenEnv } from "./callerToken";

/**
 * The pairing-grant lifecycle: mint, reserve, consume, release, sweep.
 *
 * A grant is the second of the two proofs that a human just authenticated ON A
 * SPECIFIC MACHINE, and the only one available to token shapes that carry no
 * `auth_time`/`fva` claim. Because it is the user's only way back onto their
 * own account, every state transition it can make lives here rather than being
 * spread through the register handler — `createPairingProofBroker` gives the
 * mutable "has this request proven anything yet, and is a grant still
 * restorable" state exactly one owner.
 */

/** The slice of the Worker env this module needs. */
export type PairingGrantEnv = CallerTokenEnv & { DB: D1Database };

/**
 * How long a minted pairing grant stays spendable.
 *
 * Deliberately the same order as `PAIRING_AUTH_FRESHNESS_MS`: both answer "did
 * a human just authenticate?", so a grant must not outlive the claim it stands
 * in for. It covers the sign-in, the automatic re-pair that follows it, and one
 * retry — nothing longer.
 */
export const PAIRING_GRANT_TTL_MS = 10 * 60_000;

/**
 * How long one registration may hold a pairing grant reserved before another is
 * allowed to take it.
 *
 * This is a CRASH-SAFETY bound, not a lease anyone waits on. A reservation is
 * held only across a single activity-relay hand-off — two attempts with a short
 * backoff — so a minute is generous for the happy path. What it actually bounds
 * is the bad path: a worker that dies between reserving a grant and either
 * consuming or releasing it would otherwise strand the row as permanently
 * unspendable until it expired, which is the same lockout the two-phase scheme
 * exists to remove. After this long the reservation simply does not count.
 */
export const PAIRING_GRANT_RESERVATION_MS = 60_000;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

/**
 * Mint the pairing grant for a just-completed `/device/*` sign-in.
 *
 * `accessToken` is the token this worker itself fetched from Clerk moments ago,
 * but it is re-verified rather than decoded: the user id the grant is bound to
 * decides whose revocation it can lift, and that must come from a signature
 * check, not from a base64 payload. Verification failure yields `null` — the
 * sign-in still succeeds, only the second proof path is unavailable.
 *
 * Only the hash is stored. The plaintext exists in one response body and in the
 * signing-in machine's memory; a dump of this D1 yields nothing spendable.
 */
export async function mintPairingGrant(
  env: PairingGrantEnv,
  args: { accessToken: string; machineKey: string; nowMs: number },
): Promise<string | null> {
  let userId: string;
  try {
    userId = await verifyCallerToken(args.accessToken, env);
  } catch {
    return null;
  }
  const grant = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare(`
    insert into machine_pairing_grants (grant_hash, user_id, machine_key, created_at, expires_at)
    values (?, ?, ?, ?, ?)
    on conflict(grant_hash) do nothing
  `).bind(
    await sha256Base64Url(grant),
    userId,
    args.machineKey,
    args.nowMs,
    args.nowMs + PAIRING_GRANT_TTL_MS,
  ).run();
  return grant;
}

/**
 * Reserve a pairing grant: phase one of spending it.
 *
 * One statement still carries every rule the grant exists to enforce — it must
 * belong to this caller, name this machine, still be inside its TTL, and not
 * already be held by another in-flight registration — because splitting them
 * into a read and a later write would let two concurrent registrations both
 * observe a spendable row. `changes === 1` is therefore the whole proof.
 *
 * What the reservation buys over the plain delete this replaced is a spend that
 * can be undone. The relay hand-off that follows can fail, and destroying the
 * grant before knowing the outcome made a relay outage cost the user their only
 * way back onto the account. A reserved grant can be put back byte for byte
 * (`releaseReservedPairingGrant`) — no fresh expiry, no read-then-write.
 */
async function reservePairingGrant(
  env: PairingGrantEnv,
  args: { userId: string; machineKey: string; grant: string; nowMs: number },
): Promise<boolean> {
  const result = await env.DB.prepare(`
    update machine_pairing_grants
       set reserved_at = ?
     where grant_hash = ? and user_id = ? and machine_key = ? and expires_at > ?
       and (reserved_at is null or reserved_at <= ?)
  `).bind(
    args.nowMs,
    await sha256Base64Url(args.grant),
    args.userId,
    args.machineKey,
    args.nowMs,
    args.nowMs - PAIRING_GRANT_RESERVATION_MS,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * Phase two, success: the grant is spent for good.
 *
 * `reserved_at` is part of the predicate so this only ever deletes the
 * reservation THIS request took. A stale reservation another registration has
 * since claimed is not ours to consume.
 */
async function consumeReservedPairingGrant(
  env: PairingGrantEnv,
  args: { userId: string; machineKey: string; grant: string; reservedAt: number },
): Promise<void> {
  await env.DB.prepare(`
    delete from machine_pairing_grants
     where grant_hash = ? and user_id = ? and machine_key = ? and reserved_at = ?
  `).bind(
    await sha256Base64Url(args.grant),
    args.userId,
    args.machineKey,
    args.reservedAt,
  ).run();
}

/**
 * Phase two, failure: put the grant back exactly as it was.
 *
 * Only `reserved_at` is cleared. `expires_at` is untouched on purpose — an
 * attacker who can force relay failures must not be able to keep a grant alive
 * past the TTL it was minted with, so a release restores spendability without
 * extending the window. Same `reserved_at` predicate as the consume, for the
 * same reason.
 */
async function releaseReservedPairingGrant(
  env: PairingGrantEnv,
  args: { userId: string; machineKey: string; grant: string; reservedAt: number },
): Promise<void> {
  await env.DB.prepare(`
    update machine_pairing_grants
       set reserved_at = null
     where grant_hash = ? and user_id = ? and machine_key = ? and reserved_at = ?
  `).bind(
    await sha256Base64Url(args.grant),
    args.userId,
    args.machineKey,
    args.reservedAt,
  ).run();
}

/**
 * How a register call proved that a human just authenticated ON THIS MACHINE.
 *
 * Two privileged operations sit behind this one bar — lifting a revocation, and
 * superseding the rows a rotated machine key left behind — and they must sit
 * behind the SAME bar. Everything else in a register request (`deviceId`,
 * `pairing`, the machine key itself) is caller-supplied and therefore forgeable
 * by exactly the removed machine these gates exist to stop.
 */
export type PairingProof =
  /** An `auth_time`/`fva` claim on the caller's own verified token. Costs nothing. */
  | { kind: "claim" }
  /** A grant, reserved and still restorable. Must be consumed or released before the response. */
  | { kind: "grant"; grant: string; reservedAt: number }
  /** A grant already consumed earlier in this request: still proof, no longer spendable. */
  | { kind: "spent_grant" }
  /** Nothing was proven. */
  | { kind: "none" };

/**
 * Establish the proof, spending a grant only if the claim path cannot answer.
 *
 * The claim is checked first so a genuinely fresh sign-in never burns a grant
 * it does not need, and it is honored on any register call because it is a
 * property of the token this worker already verified — no client assertion is
 * involved. The grant is the fallback, and it is honored ONLY on a deliberate
 * `pairing: true` link: it is a single-use credential, and a background
 * heartbeat that happens to still be carrying one must leave it untouched.
 */
async function acquirePairingProof(
  env: PairingGrantEnv,
  args: PairingProofArgs,
): Promise<PairingProof> {
  if (args.freshInteractiveAuthentication) return { kind: "claim" };
  if (!args.pairing || !args.pairingGrant) return { kind: "none" };
  const reserved = await reservePairingGrant(env, {
    userId: args.userId,
    machineKey: args.machineKey,
    grant: args.pairingGrant,
    nowMs: args.nowMs,
  });
  return reserved
    ? { kind: "grant", grant: args.pairingGrant, reservedAt: args.nowMs }
    : { kind: "none" };
}

export type PairingProofArgs = {
  userId: string;
  machineKey: string;
  /** The register call's `pairing` flag: a grant is only ever spent on a deliberate link. */
  pairing: boolean;
  pairingGrant: string | null;
  freshInteractiveAuthentication: boolean;
  nowMs: number;
};

/**
 * One owner for the "what has this request proven, and is a grant still
 * restorable" state.
 *
 * A single register call can need the proof twice — once to lift a revocation,
 * once to supersede phantom duplicates — and the reserved grant behind it must
 * be spendable exactly once across both. Handing the register handler a broker
 * instead of four loose functions and a mutable local is what makes that
 * impossible to get wrong: the grant is reserved at most once, and `consume`
 * and `release` are the only ways out of that reservation.
 */
export type PairingProofBroker = {
  /** Establish the proof, at most once per request. Cheap on every later call. */
  prove(): Promise<PairingProof>;
  /** Spend a reserved grant for good. Still proof afterwards, never spendable again. */
  consume(): Promise<void>;
  /** Put a reserved grant back byte for byte; nothing is proven any more. */
  release(): Promise<void>;
};

export function createPairingProofBroker(
  env: PairingGrantEnv,
  args: PairingProofArgs,
): PairingProofBroker {
  // Established at most once, and only when something actually needs it: a
  // plain heartbeat — the overwhelming majority of calls — must not touch the
  // grants table at all, and a request that clears a revocation and then
  // supersedes duplicates in the same breath must not pay for the proof twice.
  let proof: PairingProof | null = null;
  return {
    async prove(): Promise<PairingProof> {
      proof ??= await acquirePairingProof(env, args);
      return proof;
    },
    async consume(): Promise<void> {
      if (proof?.kind !== "grant") return;
      await consumeReservedPairingGrant(env, {
        userId: args.userId,
        machineKey: args.machineKey,
        grant: proof.grant,
        reservedAt: proof.reservedAt,
      });
      proof = { kind: "spent_grant" };
    },
    async release(): Promise<void> {
      if (proof?.kind !== "grant") return;
      await releaseReservedPairingGrant(env, {
        userId: args.userId,
        machineKey: args.machineKey,
        grant: proof.grant,
        reservedAt: proof.reservedAt,
      });
      proof = { kind: "none" };
    },
  };
}

/**
 * Cron sweep: an unspent grant is dead weight the moment it expires.
 *
 * Reservations are ignored on purpose. A grant that expires while a
 * registration holds it reserved was already unspendable by the time the sweep
 * ran — every phase checks `expires_at` — so removing it costs nothing, and the
 * release that follows simply matches no row.
 */
export async function cleanupExpiredPairingGrants(
  env: { DB: D1Database },
  nowMs = Date.now(),
): Promise<number> {
  const result = await env.DB
    .prepare("delete from machine_pairing_grants where expires_at <= ?")
    .bind(nowMs)
    .run();
  return result.meta.changes ?? 0;
}
