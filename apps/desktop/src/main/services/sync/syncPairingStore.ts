import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { SyncPairingSession, SyncPeerMetadata } from "../../../shared/types";
import { nowIso, safeJsonParse, writeTextAtomic } from "../shared/utils";

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
  codeTtlMs?: number;
};

const DEFAULT_CODE_TTL_MS = 10 * 60 * 1000;

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function createSyncPairingStore(args: SyncPairingStoreArgs) {
  const codeTtlMs = Math.max(60_000, Math.floor(args.codeTtlMs ?? DEFAULT_CODE_TTL_MS));
  fs.mkdirSync(path.dirname(args.filePath), { recursive: true });

  let activeSession: SyncPairingSession | null = null;

  const readRecords = (): PairingSecretsFile => {
    if (!fs.existsSync(args.filePath)) return {};
    return safeJsonParse<PairingSecretsFile>(fs.readFileSync(args.filePath, "utf8"), {});
  };

  const writeRecords = (records: PairingSecretsFile): void => {
    writeTextAtomic(args.filePath, `${JSON.stringify(records, null, 2)}\n`);
  };

  const isExpired = (session: SyncPairingSession | null): boolean => {
    if (!session) return true;
    const expiresAtMs = Date.parse(session.expiresAt);
    return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
  };

  const mintSession = (): SyncPairingSession => {
    const issuedAt = nowIso();
    const expiresAt = new Date(Date.now() + codeTtlMs).toISOString();
    activeSession = {
      code: randomBytes(3).toString("hex").slice(0, 6).toUpperCase(),
      issuedAt,
      expiresAt,
    };
    return activeSession;
  };

  const ensureSession = (): SyncPairingSession => {
    if (isExpired(activeSession)) {
      return mintSession();
    }
    return activeSession!;
  };

  return {
    getCodeTtlMs(): number {
      return codeTtlMs;
    },

    getActiveSession(): SyncPairingSession {
      return ensureSession();
    },

    refreshSession(): SyncPairingSession {
      return mintSession();
    },

    pairPeer(peer: SyncPeerMetadata, code: string): { deviceId: string; secret: string } {
      const session = ensureSession();
      if (session.code !== code.trim().toUpperCase()) {
        throw new Error("Invalid pairing code.");
      }
      if (isExpired(session)) {
        throw new Error("Pairing code expired.");
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
      activeSession = null;
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
