import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SyncPeerMetadata } from "../../../../desktop/src/shared/types";
import { nowIso, safeJsonParse, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";
import type { SyncPinStore } from "./syncPinStore";

export type SyncPairingRecord = {
  secretHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  peerName: string;
  peerPlatform: string;
  peerDeviceType: string;
  /**
   * Base64 X9.63 P-256 public key of the device's Secure Enclave DPoP key.
   * Once present, paired hellos from this device must carry a valid proof.
   */
  dpopPublicKey?: string | null;
};

type PairingSecretsFile = Record<string, SyncPairingRecord>;

type SyncPairingStoreArgs = {
  filePath: string;
  pinStore: SyncPinStore;
};

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
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

function pairingError(code: "pin_not_set" | "invalid_pin", message: string): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

export function createSyncPairingStore(args: SyncPairingStoreArgs) {
  fs.mkdirSync(path.dirname(args.filePath), { recursive: true });

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

  return {
    pairPeer(peer: SyncPeerMetadata, pin: string, options?: { dpopPublicKey?: string | null }): { deviceId: string; secret: string } {
      if (!args.pinStore.hasPin()) {
        throw pairingError("pin_not_set", "No pairing PIN is set on this computer.");
      }
      if (!args.pinStore.verifyPin(pin)) {
        throw pairingError("invalid_pin", "Incorrect pairing PIN.");
      }
      const secret = randomBytes(24).toString("hex");
      const records = readRecords();
      const existing = records[peer.deviceId] ?? null;
      const offeredDpopKey = options?.dpopPublicKey?.trim() || null;
      const dpopPublicKey = offeredDpopKey && isValidDpopPublicKey(offeredDpopKey) ? offeredDpopKey : null;
      records[peer.deviceId] = {
        secretHash: hashSecret(secret),
        createdAt: existing?.createdAt ?? nowIso(),
        lastUsedAt: null,
        peerName: peer.deviceName,
        peerPlatform: peer.platform,
        peerDeviceType: peer.deviceType,
        // Re-pairing (PIN gated) may rotate or introduce the device key; a
        // re-pair without a key keeps the existing one rather than downgrading.
        dpopPublicKey: dpopPublicKey ?? existing?.dpopPublicKey ?? null,
      };
      writeRecords(records);
      return {
        deviceId: peer.deviceId,
        secret,
      };
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
  };
}

export type SyncPairingStore = ReturnType<typeof createSyncPairingStore>;
