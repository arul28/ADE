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
};

type PairingSecretsFile = Record<string, SyncPairingRecord>;

type SyncPairingStoreArgs = {
  filePath: string;
  pinStore: SyncPinStore;
};

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
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
    writeTextAtomic(args.filePath, `${JSON.stringify(records, null, 2)}\n`);
    try {
      fs.chmodSync(args.filePath, 0o600);
    } catch {
      // ignore chmod failures on platforms that don't support it
    }
  };

  return {
    pairPeer(peer: SyncPeerMetadata, pin: string): { deviceId: string; secret: string } {
      if (!args.pinStore.hasPin()) {
        throw pairingError("pin_not_set", "No pairing PIN is set on this computer.");
      }
      if (!args.pinStore.verifyPin(pin)) {
        throw pairingError("invalid_pin", "Incorrect pairing PIN.");
      }
      const secret = randomBytes(24).toString("hex");
      const records = readRecords();
      const existing = records[peer.deviceId] ?? null;
      records[peer.deviceId] = {
        secretHash: hashSecret(secret),
        createdAt: existing?.createdAt ?? nowIso(),
        lastUsedAt: null,
        peerName: peer.deviceName,
        peerPlatform: peer.platform,
        peerDeviceType: peer.deviceType,
      };
      writeRecords(records);
      return {
        deviceId: peer.deviceId,
        secret,
      };
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
