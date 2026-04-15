import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { SyncPeerMetadata } from "../../../shared/types";
import { nowIso, safeJsonParse, writeTextAtomic } from "../shared/utils";
import type { SyncPinStore } from "./syncPinStore";

type PairingRecord = {
  secretHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  peerName: string;
  peerPlatform: string;
  peerDeviceType: string;
};

type PairingSecretsFile = Record<string, PairingRecord>;

type SyncPairingStoreArgs = {
  filePath: string;
  pinStore: SyncPinStore;
};

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function createSyncPairingStore(args: SyncPairingStoreArgs) {
  fs.mkdirSync(path.dirname(args.filePath), { recursive: true });

  const readRecords = (): PairingSecretsFile => {
    if (!fs.existsSync(args.filePath)) return {};
    return safeJsonParse<PairingSecretsFile>(fs.readFileSync(args.filePath, "utf8"), {});
  };

  const writeRecords = (records: PairingSecretsFile): void => {
    writeTextAtomic(args.filePath, `${JSON.stringify(records, null, 2)}\n`);
  };

  return {
    pairPeer(peer: SyncPeerMetadata, pin: string): { deviceId: string; secret: string } {
      const storedPin = args.pinStore.getPin();
      if (!storedPin) {
        const err = new Error("No pairing PIN is set on this computer.");
        (err as Error & { code?: string }).code = "pin_not_set";
        throw err;
      }
      if (storedPin !== pin.trim()) {
        const err = new Error("Incorrect pairing PIN.");
        (err as Error & { code?: string }).code = "invalid_pin";
        throw err;
      }
      const secret = randomBytes(24).toString("hex");
      const records = readRecords();
      records[peer.deviceId] = {
        secretHash: hashSecret(secret),
        createdAt: nowIso(),
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
      const records = readRecords();
      const entry = records[deviceId];
      if (!entry) return false;
      if (entry.secretHash !== hashSecret(secret)) return false;
      entry.lastUsedAt = nowIso();
      writeRecords(records);
      return true;
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
