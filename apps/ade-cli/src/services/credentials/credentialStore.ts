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
const DEFAULT_MACHINE_KEY_FILE = ".machine-key";
const STORE_AAD = Buffer.from("ade.credentials.v1");

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

function writeFileAtomic(filePath: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, contents);
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
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(raw.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function readOrCreateMachineKey(machineKeyPath: string): Buffer {
  try {
    const raw = fs.readFileSync(machineKeyPath, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length === 32) return key;
    throw new Error("ADE credential machine key is invalid.");
  } catch (error: unknown) {
    if (!isEnoent(error)) throw error;
  }
  const key = crypto.randomBytes(32);
  writeFileAtomic(machineKeyPath, `${key.toString("base64")}\n`);
  return key;
}

export class EncryptedFileCredentialStore implements SyncCredentialStore {
  private readonly credentialsPath: string;
  private readonly machineKeyPath: string;

  constructor(args: { secretsDir?: string; credentialsPath?: string; machineKeyPath?: string } = {}) {
    const secretsDir = args.secretsDir ?? resolveMachineAdeLayout().secretsDir;
    this.credentialsPath = args.credentialsPath ?? path.join(secretsDir, DEFAULT_CREDENTIALS_FILE);
    this.machineKeyPath = args.machineKeyPath ?? path.join(secretsDir, DEFAULT_MACHINE_KEY_FILE);
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
    const values = this.readAll();
    values[normalized] = nextValue;
    this.writeAll(values);
  }

  deleteSync(key: string): void {
    const normalized = normalizeKey(key);
    const values = this.readAll();
    if (!(normalized in values)) return;
    delete values[normalized];
    this.writeAll(values);
  }

  private readAll(): Record<string, string> {
    const key = readOrCreateMachineKey(this.machineKeyPath);
    return deserializeStore(readJsonObject(this.credentialsPath), key);
  }

  private writeAll(values: Record<string, string>): void {
    const key = readOrCreateMachineKey(this.machineKeyPath);
    writeFileAtomic(this.credentialsPath, `${JSON.stringify(serializeStore(values, key), null, 2)}\n`);
  }
}

export class ElectronSafeStorageCredentialStore implements SyncCredentialStore {
  private readonly safeStorage: SafeStorageLike;
  private readonly credentialsPath: string;

  constructor(args: { safeStorage: SafeStorageLike; credentialsPath?: string; secretsDir?: string }) {
    this.safeStorage = args.safeStorage;
    const secretsDir = args.secretsDir ?? resolveMachineAdeLayout().secretsDir;
    this.credentialsPath = args.credentialsPath ?? path.join(secretsDir, DEFAULT_CREDENTIALS_FILE);
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
    const values = this.readAll();
    values[normalized] = nextValue;
    this.writeAll(values);
  }

  deleteSync(key: string): void {
    const normalized = normalizeKey(key);
    const values = this.readAll();
    if (!(normalized in values)) return;
    delete values[normalized];
    this.writeAll(values);
  }

  private readAll(): Record<string, string> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Electron safeStorage is unavailable.");
    }
    try {
      const encrypted = fs.readFileSync(this.credentialsPath);
      const decrypted = this.safeStorage.decryptString(encrypted);
      const parsed = JSON.parse(decrypted) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    } catch (error: unknown) {
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
