import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import type { SyncDpopProof } from "../../../../desktop/src/shared/types/sync";

/**
 * DPoP-style proof-of-possession for paired sync connections.
 *
 * The phone holds a P-256 private key in the Secure Enclave. Pairing (PIN
 * gated) registers the public key; each hello then signs a fresh challenge:
 *
 *   ade-dpop-v1 \n deviceId \n sha256(pairedSecret) \n timestamp \n nonce
 *
 * Binding the paired secret's hash scopes a proof to one host (each host mints
 * its own secret), the timestamp bounds the replay window, and a short-lived
 * nonce cache kills replays inside the window. Signatures are DER-encoded
 * ECDSA-SHA256 — exactly what `SecKeyCreateSignature` with
 * `.ecdsaSignatureMessageX962SHA256` emits.
 */
export const SYNC_DPOP_CONTEXT = "ade-dpop-v1";
export const SYNC_DPOP_MAX_SKEW_SECONDS = 120;
export const SYNC_DPOP_NONCE_TTL_MS = 10 * 60 * 1000;
const SYNC_DPOP_NONCE_CACHE_MAX = 4096;
const SYNC_DPOP_NONCES_PER_DEVICE_MAX = 256;
const X963_UNCOMPRESSED_LENGTH = 65;

export function buildSyncDpopChallenge(args: {
  deviceId: string;
  secretSha256Hex: string;
  timestamp: number;
  nonce: string;
}): string {
  return [
    SYNC_DPOP_CONTEXT,
    args.deviceId,
    args.secretSha256Hex,
    String(Math.floor(args.timestamp)),
    args.nonce,
  ].join("\n");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Parses a base64 X9.63 (04 || X || Y) P-256 public key into a KeyObject. */
export function publicKeyFromX963Base64(publicKey: string): KeyObject | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(publicKey, "base64");
  } catch {
    return null;
  }
  if (raw.length !== X963_UNCOMPRESSED_LENGTH || raw[0] !== 0x04) return null;
  try {
    return createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
  } catch {
    return null;
  }
}

export type SyncDpopVerification =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "invalid_key"
        | "invalid_signature"
        | "stale_timestamp"
        | "replayed_nonce"
        | "nonce_cache_saturated"
        | "invalid_proof";
    };

export function verifySyncDpopProof(args: {
  publicKeyX963Base64: string;
  deviceId: string;
  secret: string;
  proof: SyncDpopProof;
  nowSeconds?: number;
  /** Returns true for a replay, "saturated" when no safe slot remains, or false after recording. */
  checkAndRecordNonce?: (nonce: string) => boolean | "saturated";
}): SyncDpopVerification {
  const nonce = typeof args.proof.nonce === "string" ? args.proof.nonce.trim() : "";
  const signature = typeof args.proof.signature === "string" ? args.proof.signature.trim() : "";
  const timestamp = Number(args.proof.timestamp);
  if (!nonce || nonce.length > 128 || !signature || !Number.isFinite(timestamp)) {
    return { ok: false, reason: "invalid_proof" };
  }
  const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > SYNC_DPOP_MAX_SKEW_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const key = publicKeyFromX963Base64(args.publicKeyX963Base64);
  if (!key) return { ok: false, reason: "invalid_key" };

  const challenge = buildSyncDpopChallenge({
    deviceId: args.deviceId,
    secretSha256Hex: sha256Hex(args.secret),
    timestamp,
    nonce,
  });
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, "base64");
  } catch {
    return { ok: false, reason: "invalid_proof" };
  }
  let verified = false;
  try {
    verified = verifySignature("sha256", Buffer.from(challenge, "utf8"), key, signatureBytes);
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: "invalid_signature" };
  // Only burn the nonce after the signature checks out, so an attacker cannot
  // spend a victim's nonce with a garbage signature.
  const nonceVerdict = args.checkAndRecordNonce?.(nonce);
  if (nonceVerdict === "saturated") {
    return { ok: false, reason: "nonce_cache_saturated" };
  }
  if (nonceVerdict) {
    return { ok: false, reason: "replayed_nonce" };
  }
  return { ok: true };
}

/**
 * Shared paired-hello DPoP policy. Returns a rejection reason or null when the
 * hello passes. Rules:
 * - record has a key → a valid proof is required (fail closed; the proof's
 *   inline publicKey is ignored so a stolen secret cannot swap keys),
 * - record has no key but the proof carries one and verifies → adopt (TOFU)
 *   via `adoptPublicKey`,
 * - record has no key and no proof → allowed unless `requireDpop`.
 */
export function evaluatePairedHelloDpop(input: {
  storedPublicKey: string | null | undefined;
  deviceId: string;
  secret: string;
  proof: SyncDpopProof | null;
  requireDpop: boolean;
  nonceCache: SyncDpopNonceCache;
  adoptPublicKey?: (publicKey: string) => void;
}): string | null {
  const storedKey = input.storedPublicKey?.trim() || null;
  const checkAndRecordNonce = (nonce: string) => input.nonceCache.checkAndRecord(input.deviceId, nonce);
  if (storedKey) {
    if (!input.proof) return "proof_required";
    const verdict = verifySyncDpopProof({
      publicKeyX963Base64: storedKey,
      deviceId: input.deviceId,
      secret: input.secret,
      proof: input.proof,
      checkAndRecordNonce,
    });
    return verdict.ok ? null : verdict.reason;
  }
  const offeredKey = input.proof?.publicKey?.trim() || null;
  if (input.proof && offeredKey) {
    const verdict = verifySyncDpopProof({
      publicKeyX963Base64: offeredKey,
      deviceId: input.deviceId,
      secret: input.secret,
      proof: input.proof,
      checkAndRecordNonce,
    });
    if (!verdict.ok) return verdict.reason;
    input.adoptPublicKey?.(offeredKey);
    return null;
  }
  return input.requireDpop ? "dpop_required" : null;
}

/**
 * The next step a user can actually take for each DPoP rejection reason. These
 * are sent verbatim to the client, which used to render every one of them as
 * "Sync authentication failed." — a clock skew and a stolen-key rejection are
 * not the same problem and must not read the same.
 */
export function syncDpopFailureMessage(reason: string): string {
  switch (reason) {
    case "proof_required":
    case "dpop_required":
      return "This device did not present its security key. Update ADE on the device, then pair it again.";
    case "stale_timestamp":
      return "This device's clock is too far from this machine's. Fix the date and time on both, then try again.";
    case "replayed_nonce":
      return "This device's security proof had already been used. Try connecting again.";
    case "nonce_cache_saturated":
      return "This machine is handling too many recent security proofs. Wait a moment, then try again.";
    default:
      return "This device could not prove it holds the security key this machine has on record. Pair it again.";
  }
}

/**
 * Nonce replay cache partitioned by device id. Each device has its own bounded
 * budget, so a valid proof flood from one paired device cannot evict another
 * device's replay history inside the timestamp-skew window.
 */
export function createSyncDpopNonceCache(args?: {
  ttlMs?: number;
  maxEntries?: number;
  maxEntriesPerDevice?: number;
}) {
  const ttlMs = args?.ttlMs ?? SYNC_DPOP_NONCE_TTL_MS;
  const maxEntries = args?.maxEntries ?? SYNC_DPOP_NONCE_CACHE_MAX;
  const maxEntriesPerDevice =
    args?.maxEntriesPerDevice ?? SYNC_DPOP_NONCES_PER_DEVICE_MAX;
  const seenByDevice = new Map<string, Map<string, number>>();
  let entryCount = 0;

  const prune = (now: number): void => {
    for (const [deviceId, seen] of seenByDevice) {
      for (const [nonce, expiresAt] of seen) {
        if (expiresAt <= now) {
          seen.delete(nonce);
          entryCount -= 1;
        }
      }
      if (seen.size === 0) seenByDevice.delete(deviceId);
    }
  };

  return {
    /** Returns true when the nonce was already seen; records it otherwise. */
    checkAndRecord(
      deviceId: string,
      nonce: string,
      now = Date.now(),
    ): boolean | "saturated" {
      prune(now);
      let seen = seenByDevice.get(deviceId);
      if (seen?.has(nonce)) return true;
      if (seen && seen.size >= maxEntriesPerDevice) {
        const oldest = seen.keys().next().value;
        if (oldest != null) {
          seen.delete(oldest);
          entryCount -= 1;
        }
      } else if (entryCount >= maxEntries) {
        // Never evict another device's active replay history to admit a new
        // nonce. Failing closed preserves the security property under flood.
        return "saturated";
      }
      if (!seen) {
        seen = new Map();
        seenByDevice.set(deviceId, seen);
      }
      seen.set(nonce, now + ttlMs);
      entryCount += 1;
      return false;
    },
  };
}

export type SyncDpopNonceCache = ReturnType<typeof createSyncDpopNonceCache>;
