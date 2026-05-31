import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveMachineAdeLayout } from "../projects/machineLayout";

export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type SyncCredentialStore = CredentialStore & {
  getSync(key: string): string | null;
  setSync(key: string, value: string): void;
  deleteSync(key: string): void;
};

type StoredCredentialEnvelope = {
  version: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

const DEFAULT_CREDENTIALS_FILE = "credentials.json.enc";
const DEFAULT_SAFE_STORAGE_CREDENTIALS_FILE = "credentials.safe.enc";
const DEFAULT_MACHINE_KEY_FILE = ".machine-key";
const STORE_AAD = Buffer.from("ade.credentials.v1");
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;

type CredentialLockMetadata = {
  pid?: number;
  createdAt?: string;
};

function normalizeKey(key: string): string {
  const normalized = key.trim();
  if (!normalized.length) throw new Error("Credential key is required.");
  if (normalized.includes("\0")) throw new Error("Credential key cannot contain null bytes.");
  return normalized;
}

function ensureMode600(filePath: string): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort; some filesystems do not support chmod.
  }
}

function ensureDirMode700(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Best effort; some filesystems do not support chmod.
  }
}

function writeFileAtomic(filePath: string, contents: string | Buffer): void {
  ensureDirMode700(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, contents, { mode: 0o600 });
  ensureMode600(tmpPath);
  fs.renameSync(tmpPath, filePath);
  ensureMode600(filePath);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "EEXIST";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultLockPath(credentialsPath: string): string {
  return `${credentialsPath}.lock`;
}

function isSamePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function parseLockMetadata(raw: string): CredentialLockMetadata {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      pid: Number.isSafeInteger(record.pid) && Number(record.pid) > 0 ? Number(record.pid) : undefined,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
    };
  } catch {
    return {};
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: unknown }).code === "ESRCH"
    );
  }
}

function isSameLockStat(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function removeStaleLock(lockPath: string): void {
  let originalStat: fs.Stats;
  let originalRaw: string;
  try {
    originalStat = fs.statSync(lockPath);
    if (Date.now() - originalStat.mtimeMs <= LOCK_STALE_MS) return;
    originalRaw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return;
  }

  const metadata = parseLockMetadata(originalRaw);
  if (metadata.pid && isProcessRunning(metadata.pid)) return;

  try {
    const currentStat = fs.statSync(lockPath);
    if (!isSameLockStat(currentStat, originalStat)) return;
    if (fs.readFileSync(lockPath, "utf8") !== originalRaw) return;
    fs.unlinkSync(lockPath);
  } catch {
    // Another process won the lock race or removed the stale file first.
  }
}

function withCredentialFileLock<T>(lockPath: string, fn: () => T): T {
  ensureDirMode700(path.dirname(lockPath));
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | null = null;

  while (fd === null) {
    try {
      const candidateFd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(
          candidateFd,
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        );
        fd = candidateFd;
      } catch (error: unknown) {
        try {
          fs.closeSync(candidateFd);
        } catch {
          // ignore
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
        throw error;
      }
      ensureMode600(lockPath);
    } catch (error: unknown) {
      if (!isEexist(error)) throw error;
      removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for ADE credential store lock.");
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

function unlinkIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error: unknown) {
    if (!isEnoent(error)) throw error;
  }
}

function withOptionalCredentialFileLock<T>(lockPath: string, skippedLockPath: string, fn: () => T): T {
  if (isSamePath(lockPath, skippedLockPath)) return fn();
  return withCredentialFileLock(lockPath, fn);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    if (isEnoent(error)) return {};
    throw error;
  }
}

function normalizeStoredCredentialValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, storedValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof storedValue === "string") out[key] = storedValue;
  }
  return out;
}

function serializeStore(values: Record<string, string>, machineKey: Buffer): StoredCredentialEnvelope {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", machineKey, iv);
  cipher.setAAD(STORE_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(values), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function deserializeStore(raw: Record<string, unknown> | null, machineKey: Buffer): Record<string, string> {
  if (!raw || Object.keys(raw).length === 0) return {};
  if (raw.version !== 1 || raw.alg !== "aes-256-gcm") {
    throw new Error("Unsupported ADE credential store format.");
  }
  if (typeof raw.iv !== "string" || typeof raw.tag !== "string" || typeof raw.ciphertext !== "string") {
    throw new Error("ADE credential store is malformed.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", machineKey, Buffer.from(raw.iv, "base64"));
  decipher.setAAD(STORE_AAD);
  decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(raw.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return normalizeStoredCredentialValues(JSON.parse(plaintext));
  } catch {
    return {};
  }
}

function readMachineKeyIfExists(machineKeyPath: string): Buffer | null {
  try {
    const raw = fs.readFileSync(machineKeyPath, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length === 32) return key;
    throw new Error("ADE credential machine key is invalid.");
  } catch (error: unknown) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function readOrCreateMachineKey(machineKeyPath: string): Buffer {
  const existing = readMachineKeyIfExists(machineKeyPath);
  if (existing) return existing;

  const key = crypto.randomBytes(32);
  ensureDirMode700(path.dirname(machineKeyPath));
  try {
    fs.writeFileSync(machineKeyPath, `${key.toString("base64")}\n`, { flag: "wx", mode: 0o600 });
    ensureMode600(machineKeyPath);
    return key;
  } catch (error: unknown) {
    if (!isEexist(error)) throw error;
    const winner = readMachineKeyIfExists(machineKeyPath);
    if (winner) return winner;
    throw new Error("ADE credential machine key is invalid.");
  }
}

export class EncryptedFileCredentialStore implements SyncCredentialStore {
  private readonly credentialsPath: string;
  private readonly machineKeyPath: string;
  private readonly lockPath: string;

  constructor(args: { secretsDir?: string; credentialsPath?: string; machineKeyPath?: string; lockPath?: string } = {}) {
    const secretsDir = args.secretsDir ?? resolveMachineAdeLayout().secretsDir;
    this.credentialsPath = args.credentialsPath ?? path.join(secretsDir, DEFAULT_CREDENTIALS_FILE);
    this.machineKeyPath = args.machineKeyPath ?? path.join(secretsDir, DEFAULT_MACHINE_KEY_FILE);
    this.lockPath = args.lockPath ?? defaultLockPath(this.credentialsPath);
  }

  async get(key: string): Promise<string | null> {
    return this.getSync(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.setSync(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deleteSync(key);
  }

  getSync(key: string): string | null {
    const normalized = normalizeKey(key);
    return this.readAll()[normalized] ?? null;
  }

  setSync(key: string, value: string): void {
    const normalized = normalizeKey(key);
    const nextValue = value.trim();
    if (!nextValue.length) {
      this.deleteSync(normalized);
      return;
    }
    this.withLock(() => {
      const values = this.readAll();
      values[normalized] = nextValue;
      this.writeAll(values);
    });
  }

  deleteSync(key: string): void {
    const normalized = normalizeKey(key);
    this.withLock(() => {
      const values = this.readAll();
      if (!(normalized in values)) return;
      delete values[normalized];
      this.writeAll(values);
    });
  }

  private readAll(): Record<string, string> {
    const key = readOrCreateMachineKey(this.machineKeyPath);
    return deserializeStore(readJsonObject(this.credentialsPath), key);
  }

  private writeAll(values: Record<string, string>): void {
    const key = readOrCreateMachineKey(this.machineKeyPath);
    writeFileAtomic(this.credentialsPath, `${JSON.stringify(serializeStore(values, key), null, 2)}\n`);
  }

  private withLock<T>(fn: () => T): T {
    return withCredentialFileLock(this.lockPath, fn);
  }
}

export class ElectronSafeStorageCredentialStore implements SyncCredentialStore {
  private readonly safeStorage: SafeStorageLike;
  private readonly credentialsPath: string;
  private readonly legacyCredentialsPath: string;
  private readonly legacyMachineKeyPath: string;
  private readonly lockPath: string;
  private readonly legacyLockPath: string;

  constructor(args: {
    safeStorage: SafeStorageLike;
    credentialsPath?: string;
    secretsDir?: string;
    legacyCredentialsPath?: string;
    legacyMachineKeyPath?: string;
    lockPath?: string;
    legacyLockPath?: string;
  }) {
    this.safeStorage = args.safeStorage;
    const secretsDir = args.secretsDir ?? resolveMachineAdeLayout().secretsDir;
    this.credentialsPath = args.credentialsPath ?? path.join(secretsDir, DEFAULT_SAFE_STORAGE_CREDENTIALS_FILE);
    this.legacyCredentialsPath = args.legacyCredentialsPath ?? path.join(secretsDir, DEFAULT_CREDENTIALS_FILE);
    this.legacyMachineKeyPath = args.legacyMachineKeyPath ?? path.join(secretsDir, DEFAULT_MACHINE_KEY_FILE);
    this.lockPath = args.lockPath ?? defaultLockPath(this.credentialsPath);
    this.legacyLockPath = args.legacyLockPath ?? defaultLockPath(this.legacyCredentialsPath);
  }

  async get(key: string): Promise<string | null> {
    return this.getSync(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.setSync(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deleteSync(key);
  }

  getSync(key: string): string | null {
    const normalized = normalizeKey(key);
    return this.readAll()[normalized] ?? null;
  }

  setSync(key: string, value: string): void {
    const normalized = normalizeKey(key);
    const nextValue = value.trim();
    if (!nextValue.length) {
      this.deleteSync(normalized);
      return;
    }
    this.withLock(() => {
      const values = this.readAll({ safeLockHeld: true });
      values[normalized] = nextValue;
      this.writeAll(values);
    });
  }

  deleteSync(key: string): void {
    const normalized = normalizeKey(key);
    this.withLock(() => {
      const values = this.readAll({ safeLockHeld: true });
      if (!(normalized in values)) return;
      delete values[normalized];
      this.writeAll(values);
    });
  }

  private readAll(args: { safeLockHeld?: boolean } = {}): Record<string, string> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Electron safeStorage is unavailable.");
    }
    try {
      const encrypted = fs.readFileSync(this.credentialsPath);
      const decrypted = this.safeStorage.decryptString(encrypted);
      return normalizeStoredCredentialValues(JSON.parse(decrypted));
    } catch (error: unknown) {
      const legacyValues = this.migrateLegacyEncryptedFileStore(args.safeLockHeld === true);
      if (legacyValues) {
        return legacyValues;
      }
      if (isEnoent(error)) return {};
      throw error;
    }
  }

  private writeAll(values: Record<string, string>): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Electron safeStorage is unavailable.");
    }
    writeFileAtomic(this.credentialsPath, this.safeStorage.encryptString(JSON.stringify(values)));
  }

  private readLegacyEncryptedFileStore(): Record<string, string> | null {
    if (!fs.existsSync(this.legacyCredentialsPath)) return null;
    let raw: Record<string, unknown> | null;
    try {
      raw = readJsonObject(this.legacyCredentialsPath);
    } catch {
      return null;
    }
    if (!raw || Object.keys(raw).length === 0) return {};
    if (raw.version !== 1 || raw.alg !== "aes-256-gcm") return null;
    const key = readMachineKeyIfExists(this.legacyMachineKeyPath);
    if (!key) return null;
    return deserializeStore(raw, key);
  }

  private migrateLegacyEncryptedFileStore(safeLockHeld: boolean): Record<string, string> | null {
    const migrate = () => withOptionalCredentialFileLock(this.legacyLockPath, this.lockPath, () => {
      const legacyValues = this.readLegacyEncryptedFileStore();
      if (!legacyValues) return null;
      this.writeAll(legacyValues);
      this.removeLegacyFileStore();
      return legacyValues;
    });
    if (safeLockHeld) return migrate();
    return withCredentialFileLock(this.lockPath, migrate);
  }

  private removeLegacyFileStore(): void {
    unlinkIfExists(this.legacyMachineKeyPath);
    if (!isSamePath(this.legacyCredentialsPath, this.credentialsPath)) {
      unlinkIfExists(this.legacyCredentialsPath);
    }
  }

  private withLock<T>(fn: () => T): T {
    return withCredentialFileLock(this.lockPath, fn);
  }
}
