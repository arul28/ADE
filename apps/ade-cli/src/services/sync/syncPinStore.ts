import fs from "node:fs";
import path from "node:path";
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { safeJsonParse, writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";

type SyncPinStoreArgs = {
  filePath: string;
};

type LegacySyncPinFile = {
  pin: string;
  updatedAt: string;
};

type HashedSyncPinFile = {
  version: 2;
  algorithm: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  hash: string;
  updatedAt: string;
};

type SyncPinFile = LegacySyncPinFile | HashedSyncPinFile;

const PIN_PATTERN = /^\d{6}$/;
const PIN_HASH_ITERATIONS = 120_000;
const PIN_HASH_BYTES = 32;

function derivePinHash(pin: string, salt: string, iterations: number): string {
  return pbkdf2Sync(pin, salt, iterations, PIN_HASH_BYTES, "sha256").toString("hex");
}

function safeEqualHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function createHashedPinFile(pin: string, updatedAt = new Date().toISOString()): HashedSyncPinFile {
  const salt = randomBytes(16).toString("hex");
  return {
    version: 2,
    algorithm: "pbkdf2-sha256",
    iterations: PIN_HASH_ITERATIONS,
    salt,
    hash: derivePinHash(pin, salt, PIN_HASH_ITERATIONS),
    updatedAt,
  };
}

function isHashedPinFile(value: SyncPinFile | null): value is HashedSyncPinFile {
  if (!value || !("version" in value)) return false;
  return value.version === 2
    && value.algorithm === "pbkdf2-sha256"
    && Number.isInteger(value.iterations)
    && value.iterations > 0
    && typeof value.salt === "string"
    && /^[0-9a-f]+$/i.test(value.salt)
    && typeof value.hash === "string"
    && /^[0-9a-f]+$/i.test(value.hash);
}

export function createSyncPinStore(args: SyncPinStoreArgs) {
  fs.mkdirSync(path.dirname(args.filePath), { recursive: true });

  let cachedPlainPin: string | null = null;
  // Identity of the record `cachedPlainPin` belongs to. More than one store
  // instance reads this same path — the machine brain's projectless ingress
  // handler and, once a project opens, that scope's sync service — so every
  // read goes to disk and the plaintext PIN is dropped as soon as the record on
  // disk is no longer the one this instance wrote. The file is a few hundred
  // bytes; there is nothing worth caching across calls.
  let plainPinRecordId: string | null = null;

  const recordId = (record: HashedSyncPinFile | null): string | null =>
    record ? `${record.salt}:${record.hash}` : null;

  const writeRecord = (record: HashedSyncPinFile): void => {
    writeTextAtomic(args.filePath, `${JSON.stringify(record, null, 2)}\n`);
    try {
      fs.chmodSync(args.filePath, 0o600);
    } catch {
      // ignore chmod failures on platforms that don't support it
    }
  };

  const readFromDisk = (): HashedSyncPinFile | null => {
    if (!fs.existsSync(args.filePath)) return null;
    const parsed = safeJsonParse<SyncPinFile | null>(
      fs.readFileSync(args.filePath, "utf8"),
      null,
    );
    if (isHashedPinFile(parsed)) return parsed;

    const pin = typeof (parsed as LegacySyncPinFile | null)?.pin === "string"
      ? (parsed as LegacySyncPinFile).pin.trim()
      : "";
    if (!PIN_PATTERN.test(pin)) return null;

    const migrated = createHashedPinFile(pin, (parsed as LegacySyncPinFile).updatedAt);
    writeRecord(migrated);
    cachedPlainPin = pin;
    plainPinRecordId = recordId(migrated);
    return migrated;
  };

  const loadRecord = (): HashedSyncPinFile | null => {
    const record = readFromDisk();
    // The plaintext PIN only ever comes from this instance's own `setPin` (or a
    // legacy-file migration), so a record written elsewhere invalidates it:
    // `hasPin`/`verifyPin` still work, `getPin` honestly reports that this
    // instance cannot show the code.
    if (recordId(record) !== plainPinRecordId) {
      cachedPlainPin = null;
      plainPinRecordId = null;
    }
    return record;
  };

  return {
    getPin(): string | null {
      // Reload first: another instance may have replaced the PIN on disk, and
      // handing back the code this instance last set would show the user a
      // pairing code no device can use.
      loadRecord();
      return cachedPlainPin;
    },

    hasPin(): boolean {
      return loadRecord() !== null;
    },

    verifyPin(pin: string): boolean {
      const trimmed = pin.trim();
      if (!PIN_PATTERN.test(trimmed)) return false;
      const record = loadRecord();
      if (!record) return false;
      const hash = derivePinHash(trimmed, record.salt, record.iterations);
      return safeEqualHex(hash, record.hash);
    },

    setPin(pin: string): void {
      const trimmed = pin.trim();
      if (!PIN_PATTERN.test(trimmed)) {
        throw new Error("PIN must be 6 digits.");
      }
      const payload = createHashedPinFile(trimmed);
      writeRecord(payload);
      cachedPlainPin = trimmed;
      plainPinRecordId = recordId(payload);
    },

    clearPin(): void {
      try {
        fs.rmSync(args.filePath, { force: true });
      } catch {
        // ignore cleanup failures
      }
      cachedPlainPin = null;
      plainPinRecordId = null;
    },
  };
}

export type SyncPinStore = ReturnType<typeof createSyncPinStore>;
