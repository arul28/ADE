import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SyncPeerMetadata } from "../../../../desktop/src/shared/types";
import { nowIso, safeJsonParse, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";
import {
  isVerifiedAccountAttestation,
  type VerifiedAccountAttestation,
} from "../account/accountAttestationVerifier";
import type { SyncPinStore } from "./syncPinStore";

export type SyncPairingRecord = {
  secretHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  peerName: string;
  peerPlatform: string;
  peerDeviceType: string;
  /** Server-issued authorization for full runtime RPC and forwarding. */
  runtimeHostGranted?: boolean;
  /**
   * Base64 X9.63 P-256 public key of the device's Secure Enclave DPoP key.
   * Once present, paired hellos from this device must carry a valid proof.
   */
  dpopPublicKey?: string | null;
  /**
   * Clerk user that created this trust through account adoption. Missing and
   * null are deliberately local/manual for backward compatibility.
   */
  accountOwnerUserId?: string | null;
};

type PairingSecretsFile = Record<string, SyncPairingRecord>;
type RuntimeHostGrantFile = Record<string, { expiresAt: number }>;

type SyncPairingStoreArgs = {
  filePath: string;
  pinStore: SyncPinStore;
};

type NewPairingRecordOptions = {
  dpopPublicKey?: string | null;
  runtimeHostGrant?: string | null;
  /**
   * The sync host sets this only after a correct PIN arrives on a direct
   * LAN/tailnet socket. It must remain false for Relay-origin pairings.
   */
  allowDirectPinRuntimeHost?: boolean;
};

type PairingTrust =
  | { kind: "pin" }
  | { kind: "local" }
  | { kind: "account"; userId: string };

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function normalizeAccountOwnerUserId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * A pairing record's DPoP key must be a base64 uncompressed X9.63 P-256 point
 * (65 bytes, 0x04 prefix). Persisting anything else would fail-closed-lock the
 * device out of every future hello, so malformed input is treated as absent.
 */
export function isValidDpopPublicKey(value: string): boolean {
  try {
    const raw = Buffer.from(value, "base64");
    return raw.length === 65 && raw[0] === 0x04;
  } catch {
    return false;
  }
}

function safeHashEquals(expectedHash: string, actualHash: string): boolean {
  const expected = Buffer.from(expectedHash, "utf8");
  const actual = Buffer.from(actualHash, "utf8");
  if (expected.length !== actual.length) {
    timingSafeEqual(expected, Buffer.alloc(expected.length));
    return false;
  }
  return timingSafeEqual(expected, actual);
}

function pairingError(code: "pin_not_set" | "invalid_pin" | "account_not_verified", message: string): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

export function createSyncPairingStore(args: SyncPairingStoreArgs) {
  fs.mkdirSync(path.dirname(args.filePath), { recursive: true });
  const runtimeHostGrantPath = `${args.filePath}.runtime-host-grants`;

  const readRecords = (): PairingSecretsFile => {
    if (!fs.existsSync(args.filePath)) return {};
    return safeJsonParse<PairingSecretsFile>(fs.readFileSync(args.filePath, "utf8"), {});
  };

  const writeRecords = (records: PairingSecretsFile): void => {
    // 0o600 at temp-file creation so pairing secrets/DPoP keys are never
    // world-readable, even briefly before the post-write chmod.
    writeTextAtomic(args.filePath, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(args.filePath, 0o600);
    } catch {
      // ignore chmod failures on platforms that don't support it
    }
  };

  const readRuntimeHostGrants = (): RuntimeHostGrantFile => {
    if (!fs.existsSync(runtimeHostGrantPath)) return {};
    return safeJsonParse<RuntimeHostGrantFile>(
      fs.readFileSync(runtimeHostGrantPath, "utf8"),
      {},
    );
  };

  const writeRuntimeHostGrants = (grants: RuntimeHostGrantFile): void => {
    writeTextAtomic(runtimeHostGrantPath, `${JSON.stringify(grants, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(runtimeHostGrantPath, 0o600);
    } catch {
      // ignore chmod failures on platforms that don't support it
    }
  };

  const consumeRuntimeHostGrant = (token: string | null | undefined): boolean => {
    const normalized = token?.trim();
    if (!normalized) return false;
    const tokenHash = hashSecret(normalized);
    const now = Date.now();
    const grants = readRuntimeHostGrants();
    const granted = (grants[tokenHash]?.expiresAt ?? 0) > now;
    delete grants[tokenHash];
    for (const [hash, entry] of Object.entries(grants)) {
      if (!entry || entry.expiresAt <= now) delete grants[hash];
    }
    writeRuntimeHostGrants(grants);
    return granted;
  };

  const writeNewPairingRecord = (
    peer: SyncPeerMetadata,
    options?: NewPairingRecordOptions,
    trust: PairingTrust = { kind: "pin" },
  ): { deviceId: string; secret: string } => {
    // Consume every presented grant to preserve its one-time semantics. A
    // direct LAN/tailnet PIN may authorize a desktop runtime host explicitly;
    // Relay PIN pairing never gets that exception. Verified same-owner account
    // pairing and local OS/SSH trust retain their existing authorization paths.
    const consumedRuntimeHostGrant = consumeRuntimeHostGrant(options?.runtimeHostGrant);
    // A same-owner Clerk attestation is itself the approved account hop gate.
    // Only desktop peers receive runtime RPC; phone/browser peers remain on the
    // mobile allowlist even when they authenticate with the same account.
    const secret = randomBytes(24).toString("hex");
    const records = readRecords();
    const existing = records[peer.deviceId] ?? null;
    const existingAccountOwnerUserId = normalizeAccountOwnerUserId(existing?.accountOwnerUserId);
    let accountOwnerUserId: string | null = null;
    if (trust.kind === "account") {
      const requestedOwnerUserId = trust.userId.trim();
      if (!requestedOwnerUserId) {
        throw pairingError("account_not_verified", "Account identity is required.");
      }
      if (existing && !existingAccountOwnerUserId) {
        throw pairingError(
          "account_not_verified",
          "A local pairing cannot be replaced through account sign-in.",
        );
      }
      if (existingAccountOwnerUserId && existingAccountOwnerUserId !== requestedOwnerUserId) {
        throw pairingError(
          "account_not_verified",
          "This device pairing belongs to a different ADE account.",
        );
      }
      accountOwnerUserId = requestedOwnerUserId;
    }
    const runtimeHostGranted = peer.deviceType === "desktop"
      && (
        consumedRuntimeHostGrant
        || trust.kind === "account"
        || trust.kind === "local"
        || (trust.kind === "pin" && options?.allowDirectPinRuntimeHost === true)
      );
    const offeredDpopKey = options?.dpopPublicKey?.trim() || null;
    const validatedOfferedDpopKey = offeredDpopKey && isValidDpopPublicKey(offeredDpopKey)
      ? offeredDpopKey
      : null;
    const dpopPublicKey = trust.kind === "account" && existing?.dpopPublicKey
      ? existing.dpopPublicKey
      : validatedOfferedDpopKey ?? existing?.dpopPublicKey ?? null;
    records[peer.deviceId] = {
      secretHash: hashSecret(secret),
      createdAt: existing?.createdAt ?? nowIso(),
      lastUsedAt: null,
      peerName: peer.deviceName,
      peerPlatform: peer.platform,
      peerDeviceType: peer.deviceType,
      runtimeHostGranted,
      // A gated re-pair may introduce or rotate the key when its caller allows
      // that. Omitting a key preserves the existing binding without downgrade.
      dpopPublicKey,
      // PIN and local OS/SSH trust explicitly declassify an older account
      // record. A legacy record with no field remains local until rewritten.
      accountOwnerUserId,
    };
    writeRecords(records);
    return {
      deviceId: peer.deviceId,
      secret,
    };
  };

  return {
    issueRuntimeHostGrant(ttlMs = 10 * 60_000): string {
      const token = randomBytes(32).toString("base64url");
      const grants = readRuntimeHostGrants();
      const now = Date.now();
      for (const [hash, entry] of Object.entries(grants)) {
        if (!entry || entry.expiresAt <= now) delete grants[hash];
      }
      grants[hashSecret(token)] = {
        expiresAt: now + Math.max(1_000, Math.floor(ttlMs)),
      };
      writeRuntimeHostGrants(grants);
      return token;
    },

    pairPeer(peer: SyncPeerMetadata, pin: string, options?: NewPairingRecordOptions): { deviceId: string; secret: string } {
      if (!args.pinStore.hasPin()) {
        throw pairingError("pin_not_set", "No pairing PIN is set on this computer.");
      }
      if (!args.pinStore.verifyPin(pin)) {
        throw pairingError("invalid_pin", "Incorrect pairing PIN.");
      }
      return writeNewPairingRecord(peer, options, { kind: "pin" });
    },

    pairPeerViaAccount(
      peer: SyncPeerMetadata,
      attestation: VerifiedAccountAttestation,
      options?: NewPairingRecordOptions,
    ): { deviceId: string; secret: string } {
      if (!isVerifiedAccountAttestation(attestation)) {
        throw pairingError("account_not_verified", "Account attestation was not verified.");
      }
      return writeNewPairingRecord(peer, options, {
        kind: "account",
        userId: attestation.userId,
      });
    },

    /**
     * Pair a device whose operator has already authenticated as a local OS
     * user. This is intentionally not reachable from the sync wire protocol;
     * the machine-local RPC/CLI adapter is the only caller. A desktop peer is
     * granted runtime-host access because the SSH login is the authorization
     * gate, while phone/browser peers remain confined to the mobile allowlist.
     */
    pairPeerViaLocalTrust(
      peer: SyncPeerMetadata,
      options?: NewPairingRecordOptions,
    ): { deviceId: string; secret: string } {
      return writeNewPairingRecord(peer, options, { kind: "local" });
    },

    /**
     * TOFU upgrade for legacy pairings: adopt a device key on the next
     * successfully authenticated connection. Returns false when a different
     * key is already on record (never silently swap keys outside re-pairing).
     */
    adoptDpopPublicKey(deviceId: string, dpopPublicKey: string): boolean {
      const normalized = deviceId.trim();
      const key = dpopPublicKey.trim();
      if (!normalized || !key || !isValidDpopPublicKey(key)) return false;
      const records = readRecords();
      const entry = records[normalized];
      if (!entry) return false;
      if (entry.dpopPublicKey) return entry.dpopPublicKey === key;
      entry.dpopPublicKey = key;
      writeRecords(records);
      return true;
    },

    authenticate(deviceId: string, secret: string): boolean {
      const normalized = deviceId.trim();
      if (!normalized) return false;
      const records = readRecords();
      const entry = records[normalized];
      if (!entry) return false;
      if (!safeHashEquals(entry.secretHash, hashSecret(secret))) return false;
      entry.lastUsedAt = nowIso();
      writeRecords(records);
      return true;
    },

    getPairingRecord(deviceId: string): SyncPairingRecord | null {
      const normalized = deviceId.trim();
      if (!normalized) return null;
      return readRecords()[normalized] ?? null;
    },

    hasPairingRecord(deviceId: string): boolean {
      const normalized = deviceId.trim();
      if (!normalized) return false;
      return readRecords()[normalized] != null;
    },

    revoke(deviceId: string): void {
      const normalized = deviceId.trim();
      if (!normalized) return;
      const records = readRecords();
      if (!(normalized in records)) return;
      delete records[normalized];
      writeRecords(records);
    },

    revokeAccountOwnedExcept(currentOwnerUserId: string | null): string[] {
      const currentOwner = currentOwnerUserId?.trim() || null;
      const records = readRecords();
      const removed: string[] = [];
      for (const [deviceId, record] of Object.entries(records)) {
        const owner = normalizeAccountOwnerUserId(record?.accountOwnerUserId);
        // Missing/null provenance is legacy or explicitly local trust.
        if (!owner || owner === currentOwner) continue;
        delete records[deviceId];
        removed.push(deviceId);
      }
      if (removed.length > 0) writeRecords(records);
      return removed;
    },
  };
}

export type SyncPairingStore = ReturnType<typeof createSyncPairingStore>;
