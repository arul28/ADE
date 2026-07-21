import {
  createHash,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import type {
  SyncDpopProof,
  SyncRelayAuthorizationLease,
  SyncRelayReauthorizePayload,
  SyncRelayReauthorizeResultPayload,
} from "../../../../desktop/src/shared/types";
import { publicKeyFromX963Base64 } from "./syncDpop";

export const SYNC_RELAY_REAUTH_CONTEXT = "ade-relay-reauth-v1";
export const SYNC_RELAY_AUTHORIZATION_CLOSE_CODE = 4003;
export const SYNC_RELAY_REAUTH_REFRESH_LEAD_MS = 20_000;
export const SYNC_RELAY_REAUTH_GRACE_MS = 10_000;
export const SYNC_RELAY_REAUTH_MIN_REMAINING_MS = 30_000;
export const SYNC_RELAY_REAUTH_MAX_SKEW_SECONDS = 120;

const MAX_TOKEN_BYTES = 16_384;
const MAX_DEVICE_ID_CHARS = 256;
const MAX_NONCE_CHARS = 128;
const MAX_SIGNATURE_CHARS = 512;
const MAX_SUCCESS_CACHE_ENTRIES = 32;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type RelayAuthorizationSnapshot = {
  ownerUserId: string;
  expiresAtMs: number;
  challenge: string;
  /**
   * Bounded idempotency receipts for successful refreshes. These deliberately
   * contain no bearer/token plaintext so they are safe to carry across a live
   * sync-host handoff when the success response was lost in transport.
   */
  successes?: RelayAuthorizationSuccessReceipt[];
};

export type RelayAuthorizationSuccessReceipt = {
  nonce: string;
  fingerprint: string;
  result: Extract<SyncRelayReauthorizeResultPayload, { ok: true }>;
};

export type RelayAuthorizationHostIdentity = {
  userId: string;
  generation: number;
};

export type RelayAuthorizationAttestation = {
  userId: string;
  expiresAtMs: number;
};

type RelayAuthorizationLogger = {
  warn(message: string, fields?: Record<string, unknown>): void;
  info?(message: string, fields?: Record<string, unknown>): void;
};

type CachedSuccess = {
  fingerprint: string;
  result: Extract<SyncRelayReauthorizeResultPayload, { ok: true }>;
};

function clampTimerDelay(delayMs: number): number {
  return Math.max(0, Math.min(MAX_TIMER_DELAY_MS, delayMs));
}

function relayLease(snapshot: RelayAuthorizationSnapshot, graceMs: number): SyncRelayAuthorizationLease {
  return {
    expiresAt: snapshot.expiresAtMs,
    refreshAfter: snapshot.expiresAtMs - SYNC_RELAY_REAUTH_REFRESH_LEAD_MS,
    challenge: snapshot.challenge,
    graceMs,
  };
}

function failure(
  code: Extract<SyncRelayReauthorizeResultPayload, { ok: false }>["error"]["code"],
  message: string,
  retryable: boolean,
): SyncRelayReauthorizeResultPayload {
  return { ok: false, error: { code, message, retryable } };
}

function verifierErrorCode(error: unknown): string {
  return typeof (error as { code?: unknown } | null)?.code === "string"
    ? (error as { code: string }).code
    : "";
}

function parsePayload(payload: unknown): SyncRelayReauthorizePayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const deviceId = record.deviceId;
  const relayAccountToken = record.relayAccountToken;
  const proof = record.proof;
  if (
    typeof deviceId !== "string"
    || !deviceId
    || deviceId !== deviceId.trim()
    || deviceId.length > MAX_DEVICE_ID_CHARS
    || typeof relayAccountToken !== "string"
    || !relayAccountToken.trim()
    || Buffer.byteLength(relayAccountToken, "utf8") > MAX_TOKEN_BYTES
    || !proof
    || typeof proof !== "object"
    || Array.isArray(proof)
  ) {
    return null;
  }
  const proofRecord = proof as Record<string, unknown>;
  if (
    typeof proofRecord.timestamp !== "number"
    || !Number.isFinite(proofRecord.timestamp)
    || typeof proofRecord.nonce !== "string"
    || !proofRecord.nonce
    || proofRecord.nonce !== proofRecord.nonce.trim()
    || proofRecord.nonce.length > MAX_NONCE_CHARS
    || typeof proofRecord.signature !== "string"
    || !proofRecord.signature
    || proofRecord.signature.length > MAX_SIGNATURE_CHARS
  ) {
    return null;
  }
  return {
    deviceId,
    relayAccountToken,
    proof: {
      timestamp: proofRecord.timestamp,
      nonce: proofRecord.nonce,
      signature: proofRecord.signature,
      ...(typeof proofRecord.publicKey === "string" ? { publicKey: proofRecord.publicKey } : {}),
    },
  };
}

export function sha256RelayToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function buildRelayReauthorizationChallenge(args: {
  deviceId: string;
  relayAccountTokenSha256: string;
  challenge: string;
  timestamp: number;
  nonce: string;
}): string {
  return [
    SYNC_RELAY_REAUTH_CONTEXT,
    args.deviceId,
    args.relayAccountTokenSha256,
    args.challenge,
    String(Math.floor(args.timestamp)),
    args.nonce,
  ].join("\n");
}

export type RelayReauthorizationProofVerification =
  | { ok: true }
  | { ok: false; reason: "invalid_key" | "invalid_signature" | "stale_timestamp" | "invalid_proof" };

export function verifyRelayReauthorizationProof(args: {
  publicKeyX963Base64: string;
  deviceId: string;
  relayAccountToken: string;
  challenge: string;
  proof: SyncDpopProof;
  nowSeconds?: number;
}): RelayReauthorizationProofVerification {
  const timestamp = Number(args.proof.timestamp);
  const nonce = typeof args.proof.nonce === "string" ? args.proof.nonce.trim() : "";
  const signature = typeof args.proof.signature === "string" ? args.proof.signature.trim() : "";
  if (!Number.isFinite(timestamp) || !nonce || nonce.length > MAX_NONCE_CHARS || !signature) {
    return { ok: false, reason: "invalid_proof" };
  }
  const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (Math.abs(nowSeconds - timestamp) > SYNC_RELAY_REAUTH_MAX_SKEW_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const key = publicKeyFromX963Base64(args.publicKeyX963Base64);
  if (!key) return { ok: false, reason: "invalid_key" };
  const canonical = buildRelayReauthorizationChallenge({
    deviceId: args.deviceId,
    relayAccountTokenSha256: sha256RelayToken(args.relayAccountToken),
    challenge: args.challenge,
    timestamp,
    nonce,
  });
  try {
    const verified = verifySignature(
      "sha256",
      Buffer.from(canonical, "utf8"),
      key,
      Buffer.from(signature, "base64"),
    );
    return verified ? { ok: true } : { ok: false, reason: "invalid_signature" };
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
}

export function createRelayAuthorizationLifecycle(options: {
  capable: boolean;
  deviceId: () => string | null;
  pinnedPublicKey: () => string | null;
  captureHostAuthorization: () => Promise<RelayAuthorizationHostIdentity | null>;
  verifyAccountToken: (token: string, expectedUserId: string) => Promise<RelayAuthorizationAttestation>;
  sendResult: (payload: SyncRelayReauthorizeResultPayload, requestId: string | null) => void;
  close: (reason: string) => void;
  logger: RelayAuthorizationLogger;
  graceMs?: number;
  now?: () => number;
  randomChallenge?: () => string;
}) {
  const graceMs = Math.max(1_000, Math.floor(options.graceMs ?? SYNC_RELAY_REAUTH_GRACE_MS));
  const now = options.now ?? Date.now;
  const randomChallenge = options.randomChallenge ?? (() => randomBytes(24).toString("base64url"));
  const successes = new Map<string, CachedSuccess>();
  let snapshot: RelayAuthorizationSnapshot | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let generation = 0;
  let queue = Promise.resolve();

  const isCurrent = (expectedGeneration: number): boolean =>
    !closed && generation === expectedGeneration;

  const clearTimers = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer);
    if (expiryTimer) clearTimeout(expiryTimer);
    refreshTimer = null;
    expiryTimer = null;
  };

  const closeExpired = (reason: string): void => {
    if (closed) return;
    closed = true;
    clearTimers();
    options.close(reason);
  };

  const armTimers = (): void => {
    clearTimers();
    const current = snapshot;
    if (!current || closed) return;
    if (options.capable) {
      const refreshAt = current.expiresAtMs - SYNC_RELAY_REAUTH_REFRESH_LEAD_MS;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (snapshot !== current || closed) return;
        options.logger.warn("sync_relay.authorization_refresh_due", {
          deviceId: options.deviceId(),
          expiresAt: current.expiresAtMs,
          graceMs,
        });
      }, clampTimerDelay(refreshAt - now()));
      refreshTimer.unref?.();
    }
    const closeAt = current.expiresAtMs + (options.capable ? graceMs : 0);
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      if (snapshot !== current || closed) return;
      if (now() < closeAt) {
        armTimers();
        return;
      }
      closeExpired("ADE Relay account proof expired");
    }, clampTimerDelay(closeAt - now()));
    expiryTimer.unref?.();
  };

  const initialize = (initial: RelayAuthorizationSnapshot | null): void => {
    generation += 1;
    snapshot = initial
      ? {
          ownerUserId: initial.ownerUserId,
          expiresAtMs: initial.expiresAtMs,
          challenge: initial.challenge,
        }
      : null;
    closed = false;
    successes.clear();
    for (const receipt of initial?.successes ?? []) {
      if (
        typeof receipt.nonce !== "string"
        || !receipt.nonce
        || typeof receipt.fingerprint !== "string"
        || !receipt.fingerprint
        || !receipt.result?.ok
      ) continue;
      successes.set(receipt.nonce, {
        fingerprint: receipt.fingerprint,
        result: {
          ok: true,
          relayAuthorization: { ...receipt.result.relayAuthorization },
        },
      });
      if (successes.size >= MAX_SUCCESS_CACHE_ENTRIES) break;
    }
    armTimers();
  };

  const respond = (
    expectedGeneration: number,
    result: SyncRelayReauthorizeResultPayload,
    requestId: string | null,
  ): void => {
    if (!isCurrent(expectedGeneration)) return;
    options.sendResult(result, requestId);
  };

  const handleOnce = async (
    rawPayload: unknown,
    requestId: string | null,
    expectedGeneration: number,
  ): Promise<void> => {
    if (!isCurrent(expectedGeneration)) return;
    const payload = parsePayload(rawPayload);
    const current = snapshot;
    if (!options.capable || !current || !payload) {
      respond(expectedGeneration, failure("invalid_request", "Relay reauthorization request was invalid.", false), requestId);
      return;
    }
    const expectedDeviceId = options.deviceId();
    if (!expectedDeviceId || payload.deviceId !== expectedDeviceId) {
      respond(expectedGeneration, failure("invalid_proof", "Relay reauthorization device identity did not match.", false), requestId);
      return;
    }
    const fingerprint = createHash("sha256")
      .update(payload.deviceId, "utf8")
      .update("\0")
      .update(payload.relayAccountToken, "utf8")
      .update("\0")
      .update(String(payload.proof.timestamp))
      .update("\0")
      .update(payload.proof.nonce, "utf8")
      .update("\0")
      .update(payload.proof.signature, "utf8")
      .digest("hex");
    const cached = successes.get(payload.proof.nonce);
    if (cached) {
      respond(
        expectedGeneration,
        cached.fingerprint === fingerprint
          ? cached.result
          : failure("replayed_nonce", "Relay reauthorization nonce was already used.", false),
        requestId,
      );
      return;
    }
    const pinnedPublicKey = options.pinnedPublicKey()?.trim() ?? "";
    if (!pinnedPublicKey) {
      respond(expectedGeneration, failure("invalid_proof", "Relay reauthorization requires the paired device key.", false), requestId);
      return;
    }
    const proof = verifyRelayReauthorizationProof({
      publicKeyX963Base64: pinnedPublicKey,
      deviceId: payload.deviceId,
      relayAccountToken: payload.relayAccountToken,
      challenge: current.challenge,
      proof: payload.proof,
      nowSeconds: Math.floor(now() / 1_000),
    });
    if (!proof.ok) {
      respond(expectedGeneration, failure(
        proof.reason === "stale_timestamp" ? "stale_proof" : "invalid_proof",
        proof.reason === "stale_timestamp"
          ? "Relay reauthorization proof was stale."
          : "Relay reauthorization proof was invalid.",
        false,
      ), requestId);
      return;
    }

    const before = await options.captureHostAuthorization();
    if (!isCurrent(expectedGeneration)) return;
    if (!before || before.userId !== current.ownerUserId) {
      const result = failure("relay_account_changed", "The ADE account session changed.", false);
      respond(expectedGeneration, result, requestId);
      if (!isCurrent(expectedGeneration)) return;
      closeExpired("ADE account session changed");
      return;
    }

    let attestation: RelayAuthorizationAttestation;
    try {
      attestation = await options.verifyAccountToken(payload.relayAccountToken, current.ownerUserId);
    } catch (error) {
      if (!isCurrent(expectedGeneration)) return;
      const verifierCode = verifierErrorCode(error);
      options.logger.warn("sync_relay.authorization_verification_failed", {
        deviceId: expectedDeviceId,
        reason: verifierCode || "verification_failed",
      });
      if (verifierCode === "account_mismatch") {
        respond(expectedGeneration, failure(
          "relay_account_changed",
          "The Relay account token belongs to a different ADE account.",
          false,
        ), requestId);
        if (!isCurrent(expectedGeneration)) return;
        closeExpired("ADE account session changed");
        return;
      }
      if (verifierCode === "token_expired") {
        respond(expectedGeneration, failure(
          "token_expired",
          "Relay account token expired. Refresh the account token and retry.",
          true,
        ), requestId);
        return;
      }
      if (verifierCode === "verification_unavailable") {
        respond(expectedGeneration, failure(
          "verification_failed",
          "Relay account verification is temporarily unavailable.",
          true,
        ), requestId);
        return;
      }
      respond(expectedGeneration, failure(
        verifierCode === "configuration_error" ? "verification_failed" : "invalid_proof",
        verifierCode === "configuration_error"
          ? "Relay account verification is unavailable on this machine."
          : "Relay account token was invalid.",
        false,
      ), requestId);
      return;
    }
    if (!isCurrent(expectedGeneration)) return;

    const after = await options.captureHostAuthorization();
    if (!isCurrent(expectedGeneration)) return;
    if (
      attestation.userId !== current.ownerUserId
      || !after
      || after.userId !== current.ownerUserId
      || after.generation !== before.generation
    ) {
      const result = failure("relay_account_changed", "The ADE account session changed.", false);
      respond(expectedGeneration, result, requestId);
      if (!isCurrent(expectedGeneration)) return;
      closeExpired("ADE account session changed");
      return;
    }
    if (!Number.isFinite(attestation.expiresAtMs) || attestation.expiresAtMs <= current.expiresAtMs) {
      respond(expectedGeneration, failure(
        "token_not_advanced",
        "Relay account token did not advance the current lease.",
        true,
      ), requestId);
      return;
    }
    if (attestation.expiresAtMs - now() < SYNC_RELAY_REAUTH_MIN_REMAINING_MS) {
      respond(expectedGeneration, failure(
        "token_too_short",
        "Relay account token lifetime is too short to safely refresh the connection.",
        true,
      ), requestId);
      return;
    }

    if (!isCurrent(expectedGeneration)) return;
    const next: RelayAuthorizationSnapshot = {
      ownerUserId: current.ownerUserId,
      expiresAtMs: attestation.expiresAtMs,
      challenge: randomChallenge(),
    };
    snapshot = next;
    armTimers();
    const result: SyncRelayReauthorizeResultPayload = {
      ok: true,
      relayAuthorization: relayLease(next, graceMs),
    };
    successes.set(payload.proof.nonce, { fingerprint, result });
    while (successes.size > MAX_SUCCESS_CACHE_ENTRIES) {
      const oldest = successes.keys().next().value;
      if (oldest == null) break;
      successes.delete(oldest);
    }
    options.logger.info?.("sync_relay.authorization_refreshed", {
      deviceId: expectedDeviceId,
      expiresAt: next.expiresAtMs,
    });
    respond(expectedGeneration, result, requestId);
  };

  return {
    initialize,
    metadata(): SyncRelayAuthorizationLease | null {
      return options.capable && snapshot ? relayLease(snapshot, graceMs) : null;
    },
    snapshot(): RelayAuthorizationSnapshot | null {
      if (!snapshot) return null;
      return {
        ...snapshot,
        ...(successes.size > 0
          ? {
              successes: [...successes].map(([nonce, cached]) => ({
                nonce,
                fingerprint: cached.fingerprint,
                result: {
                  ok: true as const,
                  relayAuthorization: { ...cached.result.relayAuthorization },
                },
              })),
            }
          : {}),
      };
    },
    handle(payload: unknown, requestId: string | null): Promise<void> {
      const expectedGeneration = generation;
      const work = queue.catch(() => {}).then(() => handleOnce(payload, requestId, expectedGeneration));
      queue = work;
      return work;
    },
    dispose(): void {
      closed = true;
      generation += 1;
      clearTimers();
    },
  };
}

export type RelayAuthorizationLifecycle = ReturnType<typeof createRelayAuthorizationLifecycle>;
