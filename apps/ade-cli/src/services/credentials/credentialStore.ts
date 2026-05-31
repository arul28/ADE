import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
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

type CredentialStoreMigrationSource = {
  readAllForMigration(): Record<string, string>;
};

const DEFAULT_CREDENTIALS_FILE = "credentials.json.enc";
const DEFAULT_SAFE_STORAGE_CREDENTIALS_FILE = "credentials.safe.enc";
const DEFAULT_MACHINE_KEY_FILE = ".machine-key";
const STORE_AAD = Buffer.from("ade.credentials.v1");
const OS_BOUND_KEY_INFO = Buffer.from("ade.credentials.file-store.v2");
const MACOS_KEYCHAIN_SERVICE = "com.ade.runtime.credentials.file-store-key.v1";
const MACOS_KEYCHAIN_ACCOUNT = "machine";
const SAFE_STORAGE_FILE_MAGIC = Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n");
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
let cachedDefaultOsBoundKeyMaterial: Buffer | null = null;

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

function isStoredCredentialEnvelope(value: unknown): value is StoredCredentialEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<Record<keyof StoredCredentialEnvelope, unknown>>;
  return candidate.version === 1
    && candidate.alg === "aes-256-gcm"
    && typeof candidate.iv === "string"
    && typeof candidate.tag === "string"
    && typeof candidate.ciphertext === "string";
}

function isStoredCredentialEnvelopeBuffer(value: Buffer): boolean {
  try {
    return isStoredCredentialEnvelope(JSON.parse(value.toString("utf8")) as unknown);
  } catch {
    return false;
  }
}

function readSafeStoragePayload(filePath: string): { encrypted: Buffer; hasMagic: boolean } {
  const raw = fs.readFileSync(filePath);
  if (raw.subarray(0, SAFE_STORAGE_FILE_MAGIC.length).equals(SAFE_STORAGE_FILE_MAGIC)) {
    return { encrypted: raw.subarray(SAFE_STORAGE_FILE_MAGIC.length), hasMagic: true };
  }
  return { encrypted: raw, hasMagic: false };
}

export function isElectronSafeStorageCredentialFile(credentialsPath: string): boolean {
  try {
    const fd = fs.openSync(credentialsPath, "r");
    try {
      const buf = Buffer.alloc(SAFE_STORAGE_FILE_MAGIC.length);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      return bytesRead === SAFE_STORAGE_FILE_MAGIC.length && buf.equals(SAFE_STORAGE_FILE_MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
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

function deserializeStore(
  raw: Record<string, unknown> | null,
  machineKey: Buffer,
  args: { emptyOnDecryptFailure?: boolean } = {},
): Record<string, string> {
  if (!raw || Object.keys(raw).length === 0) return {};
  if (!isStoredCredentialEnvelope(raw)) {
    throw new Error("Unsupported ADE credential store format.");
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
  } catch (error: unknown) {
    if (args.emptyOnDecryptFailure !== false) return {};
    throw error;
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

function readCredentialPassphraseFromEnv(): Buffer | null {
  const passphrase = process.env.ADE_CREDENTIAL_STORE_PASSPHRASE?.trim();
  return passphrase ? Buffer.from(passphrase, "utf8") : null;
}

function readOrCreateMacKeychainMaterial(): Buffer | null {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execFileSync("security", [
      "find-generic-password",
      "-a",
      MACOS_KEYCHAIN_ACCOUNT,
      "-s",
      MACOS_KEYCHAIN_SERVICE,
      "-w",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const decoded = Buffer.from(raw, "base64");
    return decoded.length >= 32 ? decoded : Buffer.from(raw, "utf8");
  } catch {
    // Missing item or locked keychain; try to create once below.
  }

  const secret = crypto.randomBytes(32).toString("base64");
  try {
    const result = spawnSync("security", [
      "add-generic-password",
      "-a",
      MACOS_KEYCHAIN_ACCOUNT,
      "-s",
      MACOS_KEYCHAIN_SERVICE,
      "-U",
      "-w",
    ], {
      input: `${secret}\n`,
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (result.status !== 0) return null;
    return Buffer.from(secret, "base64");
  } catch {
    return null;
  }
}

function readDefaultOsBoundKeyMaterial(): Buffer | null {
  const envMaterial = readCredentialPassphraseFromEnv();
  if (envMaterial) return envMaterial;
  if (process.env.ADE_CREDENTIAL_STORE_DISABLE_OS_BINDING === "1") return null;
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") return null;
  if (cachedDefaultOsBoundKeyMaterial) return cachedDefaultOsBoundKeyMaterial;
  const material = readOrCreateMacKeychainMaterial();
  if (material) cachedDefaultOsBoundKeyMaterial = material;
  return material;
}

function deriveOsBoundCredentialKey(machineKey: Buffer, osMaterial: Buffer | null): Buffer {
  if (!osMaterial || osMaterial.length === 0) return machineKey;
  return Buffer.from(crypto.hkdfSync("sha256", osMaterial, machineKey, OS_BOUND_KEY_INFO, 32));
}

export class EncryptedFileCredentialStore implements SyncCredentialStore {
  private readonly credentialsPath: string;
  private readonly machineKeyPath: string;
  private readonly lockPath: string;
  private readonly keyMaterialProvider: () => Buffer | null;

  constructor(args: {
    secretsDir?: string;
    credentialsPath?: string;
    machineKeyPath?: string;
    lockPath?: string;
    keyMaterialProvider?: () => Buffer | null;
  } = {}) {
    const secretsDir = args.secretsDir ?? resolveMachineAdeLayout().secretsDir;
    this.credentialsPath = args.credentialsPath ?? path.join(secretsDir, DEFAULT_CREDENTIALS_FILE);
    this.machineKeyPath = args.machineKeyPath ?? path.join(secretsDir, DEFAULT_MACHINE_KEY_FILE);
    this.lockPath = args.lockPath ?? defaultLockPath(this.credentialsPath);
    this.keyMaterialProvider = args.keyMaterialProvider ?? readDefaultOsBoundKeyMaterial;
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
    return this.readAll({ allowRewrite: false })[normalized] ?? null;
  }

  setSync(key: string, value: string): void {
    const normalized = normalizeKey(key);
    const nextValue = value.trim();
    if (!nextValue.length) {
      this.deleteSync(normalized);
      return;
    }
    this.withLock(() => {
      const values = this.readAll({ allowRewrite: true });
      values[normalized] = nextValue;
      this.writeAll(values);
    });
  }

  deleteSync(key: string): void {
    const normalized = normalizeKey(key);
    this.withLock(() => {
      const values = this.readAll({ allowRewrite: true });
      if (!(normalized in values)) return;
      delete values[normalized];
      this.writeAll(values);
    });
  }

  readAllForMigration(): Record<string, string> {
    return this.readAll({ allowRewrite: false });
  }

  private readAll(args: { allowRewrite: boolean }): Record<string, string> {
    const raw = readJsonObject(this.credentialsPath);
    const machineKey = readOrCreateMachineKey(this.machineKeyPath);
    const key = deriveOsBoundCredentialKey(machineKey, this.keyMaterialProvider());
    if (!key.equals(machineKey)) {
      try {
        return deserializeStore(raw, key, { emptyOnDecryptFailure: false });
      } catch {
        const values = deserializeStore(raw, machineKey, { emptyOnDecryptFailure: true });
        if (args.allowRewrite) {
          try {
            this.writeAll(values);
          } catch {
            // Preserve read compatibility if migration cannot rewrite right now.
          }
        }
        return values;
      }
    }
    return deserializeStore(raw, machineKey, { emptyOnDecryptFailure: true });
  }

  private writeAll(values: Record<string, string>): void {
    const machineKey = readOrCreateMachineKey(this.machineKeyPath);
    const key = deriveOsBoundCredentialKey(machineKey, this.keyMaterialProvider());
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
  private readonly legacyStore: CredentialStoreMigrationSource | null;

  constructor(args: {
    safeStorage: SafeStorageLike;
    credentialsPath?: string;
    secretsDir?: string;
    legacyCredentialsPath?: string;
    legacyMachineKeyPath?: string;
    lockPath?: string;
    legacyLockPath?: string;
    legacyStore?: CredentialStoreMigrationSource | null;
    keyMaterialProvider?: () => Buffer | null;
  }) {
    this.safeStorage = args.safeStorage;
    const secretsDir = args.secretsDir ?? resolveMachineAdeLayout().secretsDir;
    this.credentialsPath = args.credentialsPath ?? path.join(secretsDir, DEFAULT_SAFE_STORAGE_CREDENTIALS_FILE);
    this.legacyCredentialsPath = args.legacyCredentialsPath ?? path.join(secretsDir, DEFAULT_CREDENTIALS_FILE);
    this.legacyMachineKeyPath = args.legacyMachineKeyPath ?? path.join(secretsDir, DEFAULT_MACHINE_KEY_FILE);
    this.lockPath = args.lockPath ?? defaultLockPath(this.credentialsPath);
    this.legacyLockPath = args.legacyLockPath ?? defaultLockPath(this.legacyCredentialsPath);
    this.legacyStore = args.legacyStore === undefined
      ? new EncryptedFileCredentialStore({
        credentialsPath: this.legacyCredentialsPath,
        machineKeyPath: this.legacyMachineKeyPath,
        lockPath: this.legacyLockPath,
        keyMaterialProvider: args.keyMaterialProvider,
      })
      : args.legacyStore;
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
    let payload: { encrypted: Buffer; hasMagic: boolean };
    try {
      payload = readSafeStoragePayload(this.credentialsPath);
    } catch (error: unknown) {
      if (isEnoent(error)) {
        const legacyValues = this.migrateLegacyStore(args.safeLockHeld === true);
        return legacyValues ?? {};
      }
      throw error;
    }
    try {
      const decrypted = this.safeStorage.decryptString(payload.encrypted);
      return normalizeStoredCredentialValues(JSON.parse(decrypted));
    } catch (error: unknown) {
      if (!payload.hasMagic && isStoredCredentialEnvelopeBuffer(payload.encrypted)) {
        const legacyValues = this.migrateLegacyStore(args.safeLockHeld === true);
        if (legacyValues) return legacyValues;
      }
      throw error;
    }
  }

  private readLegacySafeStorageFile(): Record<string, string> | null {
    if (!fs.existsSync(this.legacyCredentialsPath)) return null;
    let payload: { encrypted: Buffer; hasMagic: boolean };
    try {
      payload = readSafeStoragePayload(this.legacyCredentialsPath);
    } catch (error: unknown) {
      if (isEnoent(error)) return null;
      throw error;
    }
    if (!payload.hasMagic) return null;
    const decrypted = this.safeStorage.decryptString(payload.encrypted);
    return normalizeStoredCredentialValues(JSON.parse(decrypted));
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
    if (!isStoredCredentialEnvelope(raw)) return null;
    return this.readLegacyAll();
  }

  private readLegacyAll(): Record<string, string> {
    const legacy = this.legacyStore;
    if (legacy) return legacy.readAllForMigration();
    throw new Error("Legacy credential store cannot be migrated.");
  }

  private migrateLegacyStore(safeLockHeld: boolean): Record<string, string> | null {
    const migrate = () => withOptionalCredentialFileLock(this.legacyLockPath, this.lockPath, () => {
      const legacyValues = this.readLegacySafeStorageFile() ?? this.readLegacyEncryptedFileStore();
      if (!legacyValues) return null;
      this.writeAll(legacyValues);
      this.removeLegacyFileStore();
      return legacyValues;
    });
    if (safeLockHeld) return migrate();
    return withCredentialFileLock(this.lockPath, migrate);
  }

  private writeAll(values: Record<string, string>): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Electron safeStorage is unavailable.");
    }
    writeFileAtomic(
      this.credentialsPath,
      Buffer.concat([
        SAFE_STORAGE_FILE_MAGIC,
        this.safeStorage.encryptString(JSON.stringify(values)),
      ]),
    );
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

type KeytarModule = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

async function loadOptionalKeytar(): Promise<KeytarModule | null> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    const mod = await dynamicImport("keytar");
    const candidate = (mod && typeof mod === "object" && "default" in mod ? (mod as { default: unknown }).default : mod) as Partial<KeytarModule>;
    if (
      typeof candidate.getPassword === "function"
      && typeof candidate.setPassword === "function"
      && typeof candidate.deletePassword === "function"
    ) {
      return candidate as KeytarModule;
    }
  } catch {
    return null;
  }
  return null;
}

export class KeytarCredentialStore implements CredentialStore {
  private readonly keytar: KeytarModule;
  private readonly service: string;

  constructor(args: { keytar: KeytarModule; service?: string }) {
    this.keytar = args.keytar;
    this.service = args.service ?? "com.ade.runtime.credentials.v1";
  }

  async get(key: string): Promise<string | null> {
    return this.keytar.getPassword(this.service, normalizeKey(key));
  }

  async set(key: string, value: string): Promise<void> {
    const normalized = normalizeKey(key);
    const nextValue = value.trim();
    if (!nextValue.length) {
      await this.delete(normalized);
      return;
    }
    await this.keytar.setPassword(this.service, normalized, nextValue);
  }

  async delete(key: string): Promise<void> {
    await this.keytar.deletePassword(this.service, normalizeKey(key));
  }
}

export async function createDefaultCredentialStore(args: {
  env?: NodeJS.ProcessEnv;
  secretsDir?: string;
  preferKeytar?: boolean;
} = {}): Promise<CredentialStore> {
  const env = args.env ?? process.env;
  if (args.preferKeytar !== false && env.ADE_CREDENTIAL_STORE_DISABLE_KEYTAR !== "1") {
    const keytar = await loadOptionalKeytar();
    if (keytar) return new KeytarCredentialStore({ keytar });
  }
  return new EncryptedFileCredentialStore({ secretsDir: args.secretsDir });
}
