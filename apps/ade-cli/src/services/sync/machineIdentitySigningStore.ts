import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  decodeCanonicalBase64,
  rawPublicKeyFromSpki,
} from "../../../../desktop/src/shared/sync/adoptChannelCrypto";
import { safeJsonParse, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";
import { resolveMachineAdeLayout } from "../projects/machineLayout";

export const MACHINE_IDENTITY_SIGNING_FILE_NAME = "machine-identity-signing.json";

export type MachineIdentitySigningRecord = {
  version: 1;
  createdAt: string;
  publicKeyRawBase64: string;
  privateKeyPkcs8Base64: string;
};

export type MachineIdentitySigningKey = MachineIdentitySigningRecord & {
  privateKey: KeyObject;
};

type MachineIdentitySigningStoreLogger = {
  warn(message: string, meta?: Record<string, unknown>): void;
};

export type MachineIdentitySigningStore = {
  filePath: string;
  getOrCreate(): MachineIdentitySigningKey;
};

const storesByFilePath = new Map<string, MachineIdentitySigningStore>();

function parseRecord(raw: string): MachineIdentitySigningKey | null {
  const value = safeJsonParse<Partial<MachineIdentitySigningRecord> | null>(raw, null);
  if (
    value?.version !== 1
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
  ) {
    return null;
  }
  const publicKeyRaw = decodeCanonicalBase64(value.publicKeyRawBase64);
  const privateKeyPkcs8 = decodeCanonicalBase64(value.privateKeyPkcs8Base64);
  if (!publicKeyRaw || publicKeyRaw.byteLength !== 32 || !privateKeyPkcs8) return null;
  try {
    const privateKey = createPrivateKey({
      key: privateKeyPkcs8,
      format: "der",
      type: "pkcs8",
    });
    if (
      privateKey.asymmetricKeyType !== "ed25519"
      || !rawPublicKeyFromSpki(createPublicKey(privateKey)).equals(publicKeyRaw)
    ) {
      return null;
    }
    return {
      version: 1,
      createdAt: value.createdAt,
      publicKeyRawBase64: value.publicKeyRawBase64!,
      privateKeyPkcs8Base64: value.privateKeyPkcs8Base64!,
      privateKey,
    };
  } catch {
    return null;
  }
}

function createRecord(): MachineIdentitySigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    publicKeyRawBase64: rawPublicKeyFromSpki(publicKey).toString("base64"),
    privateKeyPkcs8Base64: privateKey.export({
      format: "der",
      type: "pkcs8",
    }).toString("base64"),
    privateKey,
  };
}

export function createMachineIdentitySigningStore(options: {
  filePath?: string;
  logger?: MachineIdentitySigningStoreLogger;
} = {}): MachineIdentitySigningStore {
  const filePath = path.resolve(
    options.filePath
      ?? path.join(resolveMachineAdeLayout().secretsDir, MACHINE_IDENTITY_SIGNING_FILE_NAME),
  );
  const existing = storesByFilePath.get(filePath);
  if (existing) return existing;
  let cached: MachineIdentitySigningKey | null = null;

  const persist = (value: MachineIdentitySigningKey): void => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const serialized: MachineIdentitySigningRecord = {
      version: value.version,
      createdAt: value.createdAt,
      publicKeyRawBase64: value.publicKeyRawBase64,
      privateKeyPkcs8Base64: value.privateKeyPkcs8Base64,
    };
    writeTextAtomic(filePath, `${JSON.stringify(serialized, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best effort on filesystems that do not expose POSIX modes.
    }
  };

  const store: MachineIdentitySigningStore = {
    filePath,
    getOrCreate(): MachineIdentitySigningKey {
      if (cached) return cached;
      let corrupt = false;
      try {
        if (fs.existsSync(filePath)) {
          const parsed = parseRecord(fs.readFileSync(filePath, "utf8"));
          if (parsed) {
            cached = parsed;
            try {
              fs.chmodSync(filePath, 0o600);
            } catch {
              // Best effort on filesystems that do not expose POSIX modes.
            }
            return parsed;
          }
          corrupt = true;
        }
      } catch {
        corrupt = true;
      }
      if (corrupt) {
        options.logger?.warn("machine_identity_signing.corrupt_regenerated", {
          filePath,
        });
      }
      const created = createRecord();
      persist(created);
      cached = created;
      return created;
    },
  };
  storesByFilePath.set(filePath, store);
  return store;
}
