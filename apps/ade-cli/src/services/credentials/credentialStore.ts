import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import {
  expectsOsBoundKeyMaterial,
  invalidateDefaultOsBoundKeyMaterialCache,
  readDefaultOsBoundKeyMaterial,
  readDefaultOsBoundKeyMaterialAsync,
} from "./osBoundKeyMaterial";

export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type CredentialStoreReadState = "available" | "missing" | "unreadable";

/**
 * Why the last synchronous read could not produce values. Coarse by design: it
 * is surfaced to product analytics so field incidence of the "brain cannot read
 * the credential file the app just wrote" class becomes measurable.
 */
export type CredentialStoreReadFailureReason =
  /** The ciphertext exists but no available key decrypts it. */
  | "decrypt_failure"
  /**
   * OS-held key material was expected but the key was derived without it. On
   * darwin that is an unreadable keychain item; on win32 a DPAPI failure throws
   * out of the read instead of returning null, so it never lands here. The name
   * stays platform-neutral because the condition it describes is.
   */
  | "no_os_key_material"
  /** The file exists but is not a recognised credential envelope. */
  | "store_format";

export type SyncCredentialStore = CredentialStore & {
  getSync(key: string): string | null;
  setSync(key: string, value: string): void;
  deleteSync(key: string): void;
  /** Atomically update the complete synchronous store when supported. */
  updateSync?(updater: (values: Record<string, string>) => boolean | void): void;
  /** Best-effort cross-process notification that persisted credentials changed. */
  onDidChange?(listener: () => void): () => void;
  /** Result of the most recent synchronous credential-file read. */
  getLastReadState?(): CredentialStoreReadState;
  /** Why the most recent read was unreadable, or null when it was not. */
  getLastReadFailureReason?(): CredentialStoreReadFailureReason | null;
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

/**
 * Every member is REQUIRED. An optional `getLastReadState()` would let a source
 * that lacks it silently skip the unreadable-store check below and re-open the
 * destroy-on-unreadable path; an optional `pruneForMigration()` would silently
 * leave migrated duplicates at rest.
 */
type CredentialStoreMigrationSource = {
  readAllForMigration(): Record<string, string>;
  /**
   * Result of the read `readAllForMigration()` just performed. It returns `{}`
   * rather than throwing for an undecryptable store, so without this the
   * migration cannot tell "empty" from "unreadable" — and migrating an
   * unreadable store deletes it.
   */
  getLastReadState(): CredentialStoreReadState;
  /**
   * Rewrites the legacy file to exactly `values` WITHOUT acquiring the store's
   * lock: the migration already holds that same lock file, and the file lock is
   * not reentrant.
   */
  pruneForMigration(values: Record<string, string>): void;
};

const DEFAULT_CREDENTIALS_FILE = "credentials.json.enc";
const DEFAULT_SAFE_STORAGE_CREDENTIALS_FILE = "credentials.safe.enc";
const DEFAULT_MACHINE_KEY_FILE = ".machine-key";
const STORE_AAD = Buffer.from("ade.credentials.v1");
const OS_BOUND_KEY_INFO = Buffer.from("ade.credentials.file-store.v2");
const SAFE_STORAGE_FILE_MAGIC = Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n");
/**
 * Credentials that MUST stay in the shared `credentials.json.enc` file store.
 *
 * The Electron-only safeStorage file is unreadable by the ADE brain
 * (com.ade.runtime) and by the `ade` CLI, so migrating these keys into it — and
 * then deleting the file store — leaves the brain signed out on a machine whose
 * app is signed in. Keep the literals in sync with:
 *   - ACCOUNT_SESSION_CREDENTIAL_KEY (services/account/accountAuthService.ts)
 *   - BOOTSTRAP_TOKEN_KEY (services/sync/brainProjectActionsSyncHandler.ts)
 * They are duplicated here rather than imported to keep this module free of
 * service-layer dependencies; credentialStore.test.ts asserts they match.
 */
const FILE_BACKED_CREDENTIAL_KEYS: readonly string[] = [
  "account.session.v1",
  // The crash-safe rotation journal is only meaningful next to the session it
  // describes. Migrating it into the Electron-only file would hide an
  // interrupted desktop rotation from the brain and the CLI, which is exactly
  // the process pair the journal exists to coordinate.
  "account.session.rotation.v1",
  "sync.bootstrapToken.v1",
];

export function isFileBackedCredentialKey(key: string): boolean {
  return FILE_BACKED_CREDENTIAL_KEYS.includes(key);
}

function fileBackedCredentialWriteError(key: string): Error {
  return new Error(
    `${key} is file-backed; write it through the file credential store `
    + "(credentials.json.enc), not the Electron-only safeStorage file the ADE "
    + "brain cannot read.",
  );
}
/**
 * How long a writer waits for the credential-file lock before giving up.
 *
 * Exported because cross-process protocols layered on this store have to
 * out-wait it. In particular the account service polls for a peer's rotated
 * refresh token after a definitive `invalid_grant`: if that poll window were
 * shorter than this timeout, a peer that legitimately won the exchange but is
 * still queued behind the lock would have its session declared dead by the
 * loser.
 */
export const CREDENTIAL_STORE_LOCK_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = CREDENTIAL_STORE_LOCK_TIMEOUT_MS;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const CREDENTIAL_CHANGE_POLL_INTERVAL_MS = 250;
/** Bounds OS key-material re-reads when a store keeps failing to decrypt. */
const KEY_MATERIAL_SELF_HEAL_INTERVAL_MS = 30_000;

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

/**
 * Windows does not report lock contention as EEXIST the way POSIX does.
 *
 * Deleting a file on Windows only unlinks the name once every open handle to it
 * closes, so between one holder's unlink and the last handle drop the lock name
 * still occupies the directory in a "delete pending" state. A concurrent
 * `open(lockPath, "wx")` against that name fails with a delete-pending or
 * sharing violation, which Node surfaces as EPERM, EACCES or EBUSY instead of
 * EEXIST. Those are the same "someone else holds it, try again" condition, so
 * they have to keep the acquisition loop running; treating them as fatal makes
 * every concurrent credential write a coin flip on Windows.
 */
function isLockContention(error: unknown): boolean {
  if (isEexist(error)) return true;
  if (process.platform !== "win32") return false;
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
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

type CredentialFileStatSnapshot = {
  ino: number;
  mtimeMs: number;
  size: number;
} | null;

function readCredentialFileStatSnapshot(filePath: string): CredentialFileStatSnapshot | undefined {
  try {
    const stat = fs.statSync(filePath);
    return { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (error: unknown) {
    if (isEnoent(error)) return null;
    return undefined;
  }
}

function isSameCredentialFileStat(
  left: CredentialFileStatSnapshot,
  right: CredentialFileStatSnapshot,
): boolean {
  if (left === null || right === null) return left === right;
  return left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;
}

class CredentialFileStatWatcher {
  private previous: CredentialFileStatSnapshot | undefined;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly filePath: string,
    private readonly listener: () => void,
    private readonly intervalMs: number | null,
  ) {}

  start(): void {
    this.previous = readCredentialFileStatSnapshot(this.filePath);
    if (this.intervalMs === null) return;
    this.timer = setInterval(() => this.checkNow(), this.intervalMs);
    this.timer.unref();
  }

  checkNow(): void {
    const current = readCredentialFileStatSnapshot(this.filePath);
    if (current === undefined) return;
    if (this.previous === undefined) {
      this.previous = current;
      return;
    }
    if (isSameCredentialFileStat(current, this.previous)) return;
    this.previous = current;
    try {
      this.listener();
    } catch {
      // Credential observers are best-effort; one subscriber must not stop
      // the watcher or prevent sibling subscribers from seeing the change.
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
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
      if (!isLockContention(error)) throw error;
      removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for ADE credential store lock.", { cause: error });
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

async function readJsonObjectAsync(filePath: string): Promise<{
  value: Record<string, unknown> | null;
  exists: boolean;
}> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: null, exists: true };
    }
    return { value: parsed as Record<string, unknown>, exists: true };
  } catch (error: unknown) {
    if (isEnoent(error)) return { value: {}, exists: false };
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

async function readMachineKeyIfExistsAsync(machineKeyPath: string): Promise<Buffer | null> {
  try {
    const raw = (await fs.promises.readFile(machineKeyPath, "utf8")).trim();
    const key = Buffer.from(raw, "base64");
    if (key.length === 32) return key;
    throw new Error("ADE credential machine key is invalid.");
  } catch (error: unknown) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

async function readOrCreateMachineKeyAsync(machineKeyPath: string): Promise<Buffer> {
  const existing = await readMachineKeyIfExistsAsync(machineKeyPath);
  if (existing) return existing;

  const key = crypto.randomBytes(32);
  await fs.promises.mkdir(path.dirname(machineKeyPath), { recursive: true, mode: 0o700 });
  try {
    await fs.promises.writeFile(machineKeyPath, `${key.toString("base64")}\n`, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") {
      await fs.promises.chmod(machineKeyPath, 0o600).catch(() => undefined);
    }
    return key;
  } catch (error: unknown) {
    if (!isEexist(error)) throw error;
    const winner = await readMachineKeyIfExistsAsync(machineKeyPath);
    if (winner) return winner;
    throw new Error("ADE credential machine key is invalid.");
  }
}

function deriveOsBoundCredentialKey(machineKey: Buffer, osMaterial: Buffer | null): Buffer {
  if (!osMaterial || osMaterial.length === 0) return machineKey;
  return Buffer.from(crypto.hkdfSync("sha256", osMaterial, machineKey, OS_BOUND_KEY_INFO, 32));
}

function isSameKeyMaterial(left: Buffer | null, right: Buffer | null): boolean {
  if (!left || !right) return !left && !right;
  return left.equals(right);
}

/**
 * How a credential store obtains — and gives up on — OS-bound key material.
 *
 * The three members are correlated: `invalidate()` must drop whatever cache
 * backs `read()`/`readAsync()`, or the self-heal retry re-reads the same stale
 * material. Injecting the trio together makes that contract explicit; omitting
 * the whole object takes the process-wide OS defaults.
 *
 * Every member receives `keyBindingDir` — the directory this store's machine key
 * lives in, which is where the rest of its key derivation belongs too. macOS
 * ignores it (one global keychain item per machine) but Windows DPAPI material
 * is protected per directory, so without it a store with a custom
 * `machineKeyPath` would be handed a different store's key. Sources that do not
 * care may ignore the argument.
 */
export type CredentialKeyMaterialSource = {
  read(keyBindingDir: string): Buffer | null;
  /** Defaults to an asynchronous wrapper around `read()`. */
  readAsync?(keyBindingDir: string): Promise<Buffer | null>;
  /**
   * Drops whatever cache backs the readers so a failed decrypt can be retried
   * against freshly-read material. Omit to opt out of self-heal entirely.
   */
  invalidate?(keyBindingDir: string): void;
};

const DEFAULT_KEY_MATERIAL_SOURCE: Required<CredentialKeyMaterialSource> = {
  read: readDefaultOsBoundKeyMaterial,
  readAsync: readDefaultOsBoundKeyMaterialAsync,
  invalidate: invalidateDefaultOsBoundKeyMaterialCache,
};

type CredentialDecodeAttempt =
  | {
    ok: true;
    values: Record<string, string>;
    /** The key the store SHOULD be sealed with, whichever one actually read it. */
    key: Buffer;
    rewriteWithCurrentKey: boolean;
  }
  | { ok: false; error: unknown; osBound: boolean; reason: CredentialStoreReadFailureReason };

/**
 * One decrypt attempt for a given piece of OS key material.
 *
 * The os-bound key is tried first; a failure there falls back to the bare
 * machine key so genuine legacy ciphertext can be rewritten. If that fallback
 * also fails the ciphertext is left untouched — a rotated/foreign key must
 * never cause an empty store to be written over real credentials.
 */
function decodeCredentialStore(
  raw: Record<string, unknown> | null,
  machineKey: Buffer,
  material: Buffer | null,
): CredentialDecodeAttempt {
  const formatIsUnsupported = raw != null
    && Object.keys(raw).length > 0
    && !isStoredCredentialEnvelope(raw);
  const key = deriveOsBoundCredentialKey(machineKey, material);
  const osBound = !key.equals(machineKey);
  // The os-bound key first, then the bare machine key. Anything decrypted by a
  // later candidate is genuine legacy ciphertext and may be rewritten.
  const candidates = osBound ? [key, machineKey] : [machineKey];
  let lastError: unknown;
  for (const [index, candidate] of candidates.entries()) {
    try {
      return {
        ok: true,
        values: deserializeStore(raw, candidate, { emptyOnDecryptFailure: false }),
        key,
        rewriteWithCurrentKey: index > 0,
      };
    } catch (error) {
      lastError = error;
    }
  }
  const reason: CredentialStoreReadFailureReason = formatIsUnsupported
    ? "store_format"
    : !osBound && expectsOsBoundKeyMaterial()
      ? "no_os_key_material"
      : "decrypt_failure";
  return { ok: false, error: lastError, osBound, reason };
}

/**
 * The one retry a failed decrypt gets, against freshly-read OS key material.
 *
 * Returns null when there is nothing to gain — the OS handed back the same
 * material that just failed — or when the retry failed too, so the caller keeps
 * the original (already fail-closed) attempt.
 */
function retryDecodeWithRefreshedKeyMaterial(args: {
  raw: Record<string, unknown> | null;
  machineKey: Buffer;
  previous: Buffer | null;
  refreshed: Buffer | null;
}): CredentialDecodeAttempt | null {
  if (isSameKeyMaterial(args.refreshed, args.previous)) return null;
  const retried = decodeCredentialStore(args.raw, args.machineKey, args.refreshed);
  return retried.ok ? retried : null;
}

export class EncryptedFileCredentialStore implements SyncCredentialStore {
  private readonly credentialsPath: string;
  private readonly machineKeyPath: string;
  private readonly lockPath: string;
  private readonly readKeyMaterial: () => Buffer | null;
  private readonly readKeyMaterialAsync: () => Promise<Buffer | null>;
  private readonly credentialChangePollIntervalMs: number | null;
  private readonly credentialFileWatchers = new Set<CredentialFileStatWatcher>();
  private readonly invalidateKeyMaterial: (() => void) | null;
  private lastReadState: CredentialStoreReadState = "missing";
  private lastReadFailureReason: CredentialStoreReadFailureReason | null = null;
  private lastKeyMaterialSelfHealAt = 0;

  constructor(args: {
    secretsDir?: string;
    credentialsPath?: string;
    machineKeyPath?: string;
    lockPath?: string;
    /** Omit to use the process-wide OS-bound keychain material. */
    keyMaterial?: CredentialKeyMaterialSource;
    /** Set to null when tests drive checkForChangesNow() explicitly. */
    credentialChangePollIntervalMs?: number | null;
  } = {}) {
    const secretsDir = args.secretsDir ?? resolveMachineAdeLayout().secretsDir;
    this.credentialsPath = args.credentialsPath ?? path.join(secretsDir, DEFAULT_CREDENTIALS_FILE);
    this.machineKeyPath = args.machineKeyPath ?? path.join(secretsDir, DEFAULT_MACHINE_KEY_FILE);
    const keyBindingDir = path.dirname(this.machineKeyPath);
    this.lockPath = args.lockPath ?? defaultLockPath(this.credentialsPath);
    const keyMaterial = args.keyMaterial ?? DEFAULT_KEY_MATERIAL_SOURCE;
    this.readKeyMaterial = () => keyMaterial.read(keyBindingDir);
    this.readKeyMaterialAsync = async () => (
      keyMaterial.readAsync ? keyMaterial.readAsync(keyBindingDir) : keyMaterial.read(keyBindingDir)
    );
    // An injected source owns its own cache lifetime, so self-heal is available
    // only when that source supplies the matching invalidation hook.
    this.invalidateKeyMaterial = keyMaterial.invalidate
      ? () => keyMaterial.invalidate?.(keyBindingDir)
      : null;
    this.credentialChangePollIntervalMs = args.credentialChangePollIntervalMs === undefined
      ? CREDENTIAL_CHANGE_POLL_INTERVAL_MS
      : args.credentialChangePollIntervalMs;
    if (
      this.credentialChangePollIntervalMs !== null
      && this.credentialChangePollIntervalMs <= 0
    ) {
      throw new Error("Credential change poll interval must be positive.");
    }
  }

  async get(key: string): Promise<string | null> {
    const normalized = normalizeKey(key);
    return (await this.readAllAsync())[normalized] ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.setSync(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deleteSync(key);
  }

  getSync(key: string): string | null {
    const normalized = normalizeKey(key);
    // Locked because the read may bind legacy ciphertext to the OS-bound key,
    // and that rewrite has to exclude concurrent writers.
    return this.withLock(
      () => this.readAll({ allowRewrite: false, migrateLegacy: true })[normalized] ?? null,
    );
  }

  getLastReadState(): CredentialStoreReadState {
    return this.lastReadState;
  }

  getLastReadFailureReason(): CredentialStoreReadFailureReason | null {
    // Every non-"unreadable" outcome clears this, so no state check is needed.
    return this.lastReadFailureReason;
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

  onDidChange(listener: () => void): () => void {
    ensureDirMode700(path.dirname(this.credentialsPath));
    const watcher = new CredentialFileStatWatcher(
      this.credentialsPath,
      listener,
      this.credentialChangePollIntervalMs,
    );
    this.credentialFileWatchers.add(watcher);
    watcher.start();
    return () => {
      watcher.dispose();
      this.credentialFileWatchers.delete(watcher);
    };
  }

  /** Runs the same stat comparison as the production poller without waiting. */
  checkForChangesNow(): void {
    for (const watcher of this.credentialFileWatchers) {
      watcher.checkNow();
    }
  }

  updateSync(updater: (values: Record<string, string>) => boolean | void): void {
    this.withLock(() => {
      const values = this.readAll({ allowRewrite: true });
      const shouldWrite = updater(values);
      if (shouldWrite !== false) {
        this.writeAll(values);
      }
    });
  }

  readAllForMigration(): Record<string, string> {
    return this.readAll({ allowRewrite: false });
  }

  /**
   * Rewrites this file store to exactly `values` for a migration that already
   * holds this store's lock file. The lock is a `wx` create, so re-acquiring it
   * from inside the migration would deadlock until the lock timeout; the caller
   * owns mutual exclusion here, exactly like the migration's direct unlinks.
   */
  pruneForMigration(values: Record<string, string>): void {
    this.writeAll(values);
  }

  /**
   * `migrateLegacy` binds pre-OS-bound ciphertext to the current key on a plain
   * READ, not just on a write. Only callers that already hold this store's lock
   * may pass it — the rewrite it performs is not itself locked.
   */
  private readAll(
    args: { allowRewrite: boolean; migrateLegacy?: boolean },
  ): Record<string, string> {
    const credentialsExist = fs.existsSync(this.credentialsPath);
    const raw = readJsonObject(this.credentialsPath);
    const machineKey = readOrCreateMachineKey(this.machineKeyPath);
    const material = this.readKeyMaterial();
    let attempt = decodeCredentialStore(raw, machineKey, material);
    if (
      !attempt.ok
      && attempt.reason !== "store_format"
      && this.beginKeyMaterialSelfHeal()
    ) {
      // A decrypt failure with CACHED key material is often recoverable: the
      // peer process may have won the keychain create race after this process
      // cached its own copy. Re-read the keychain once and retry before
      // declaring the store permanently unreadable. A malformed file is not a
      // key problem, so it never spends a keychain read.
      //
      // Known cost, accepted: on Windows an uncached key-material read is a
      // synchronous PowerShell spawn budgeted at 30 s, and one that has to
      // create the key spawns twice (protect, then unprotect). This path can
      // take up to two uncached reads — the failing one above plus the
      // refreshed one below — while holding the credential file lock, whose
      // peer timeout is 15 s, so a peer process can see "Timed out waiting for
      // ADE credential store lock" during a recovery. The common case is
      // cheaper: the failing read is usually served from cache, which is the
      // premise of the self-heal. Accepted because the alternative is no
      // self-heal at all; raising the lock timeout or moving key-material reads
      // outside the lock is a separate change.
      const retried = retryDecodeWithRefreshedKeyMaterial({
        raw,
        machineKey,
        previous: material,
        refreshed: this.readKeyMaterial(),
      });
      if (retried) attempt = retried;
    }
    if (!attempt.ok) {
      // Preserve the historical fail-closed empty read while exposing why the
      // account record could not be obtained to publisher health.
      this.lastReadState = "unreadable";
      this.lastReadFailureReason = attempt.reason;
      if (attempt.osBound || args.allowRewrite) throw attempt.error;
      return {};
    }
    this.lastReadState = credentialsExist ? "available" : "missing";
    this.lastReadFailureReason = null;
    if (attempt.rewriteWithCurrentKey && (args.allowRewrite || args.migrateLegacy)) {
      try {
        // Seal with the key the attempt already derived, not a fresh material
        // read: after a self-heal the freshly-read material is what decrypted
        // this store, and re-asking the OS could disagree with it.
        this.writeAllWithKey(attempt.values, attempt.key);
      } catch {
        // Preserve read compatibility if migration cannot rewrite right now.
      }
    }
    return attempt.values;
  }

  /**
   * Bounds how often a failing store may re-ask the OS for key material, and
   * drops the cache behind the readers so the next read is a fresh one.
   */
  private beginKeyMaterialSelfHeal(): boolean {
    if (!this.invalidateKeyMaterial) return false;
    const now = Date.now();
    if (
      this.lastKeyMaterialSelfHealAt > 0
      && now - this.lastKeyMaterialSelfHealAt < KEY_MATERIAL_SELF_HEAL_INTERVAL_MS
    ) {
      return false;
    }
    this.lastKeyMaterialSelfHealAt = now;
    this.invalidateKeyMaterial();
    return true;
  }

  private async readAllAsync(): Promise<Record<string, string>> {
    const { value: raw, exists: credentialsExist } = await readJsonObjectAsync(this.credentialsPath);
    if (!credentialsExist) {
      this.lastReadState = "missing";
      this.lastReadFailureReason = null;
      return {};
    }
    if (!raw || Object.keys(raw).length === 0) {
      this.lastReadState = "unreadable";
      this.lastReadFailureReason = "store_format";
      throw new Error("Unsupported ADE credential store format.");
    }
    const machineKey = await readOrCreateMachineKeyAsync(this.machineKeyPath);
    const material = await this.readKeyMaterialAsync();
    let attempt = decodeCredentialStore(raw, machineKey, material);
    if (
      !attempt.ok
      && attempt.reason !== "store_format"
      && this.beginKeyMaterialSelfHeal()
    ) {
      const retried = retryDecodeWithRefreshedKeyMaterial({
        raw,
        machineKey,
        previous: material,
        refreshed: await this.readKeyMaterialAsync(),
      });
      if (retried) attempt = retried;
    }
    if (!attempt.ok) {
      this.lastReadState = "unreadable";
      this.lastReadFailureReason = attempt.reason;
      if (attempt.osBound) throw attempt.error;
      return {};
    }
    this.lastReadState = "available";
    this.lastReadFailureReason = null;
    // The asynchronous path binds legacy ciphertext too. It is the brain's read
    // path, and on a machine whose only reader is the brain the store would
    // otherwise stay machine-key-sealed forever.
    if (attempt.rewriteWithCurrentKey) this.bindLegacyCiphertextUnderLock(attempt.key);
    return attempt.values;
  }

  private writeAll(values: Record<string, string>): void {
    const machineKey = readOrCreateMachineKey(this.machineKeyPath);
    const key = deriveOsBoundCredentialKey(machineKey, this.readKeyMaterial());
    this.writeAllWithKey(values, key);
  }

  private writeAllWithKey(values: Record<string, string>, key: Buffer): void {
    writeFileAtomic(this.credentialsPath, `${JSON.stringify(serializeStore(values, key), null, 2)}\n`);
  }

  /**
   * Re-seals machine-key ciphertext with the OS-bound key, under this store's
   * lock, for a caller that does NOT already hold it.
   *
   * The re-read inside the lock is the point: a peer may have bound the file
   * while this reader waited, and re-deriving from the stale `raw` would undo
   * whatever the peer wrote. `key` is passed in rather than re-derived so the
   * asynchronous caller never touches the synchronous key-material reader.
   *
   * Best effort: a failure here only leaves the ciphertext legacy, which still
   * reads, so it must never fail the read that triggered it.
   */
  private bindLegacyCiphertextUnderLock(key: Buffer): void {
    try {
      this.withLock(() => {
        const raw = readJsonObject(this.credentialsPath);
        const machineKey = readOrCreateMachineKey(this.machineKeyPath);
        try {
          deserializeStore(raw, key, { emptyOnDecryptFailure: false });
          return;
        } catch {
          // Still legacy: fall through and bind it.
        }
        const values = deserializeStore(raw, machineKey, { emptyOnDecryptFailure: false });
        this.writeAllWithKey(values, key);
      });
    } catch {
      // Preserve read compatibility if the binding cannot happen right now.
    }
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
    keyMaterial?: CredentialKeyMaterialSource;
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
        keyMaterial: args.keyMaterial,
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
    // The migration deliberately keeps these keys out of the Electron-only
    // file. A writer that puts one back in silently signs the brain and the CLI
    // out of a machine whose app is signed in, so fail loudly instead.
    if (isFileBackedCredentialKey(normalized)) {
      throw fileBackedCredentialWriteError(normalized);
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

  updateSync(updater: (values: Record<string, string>) => boolean | void): void {
    this.withLock(() => {
      const values = this.readAll({ safeLockHeld: true });
      const before = { ...values };
      const shouldWrite = updater(values);
      if (shouldWrite === false) return;
      // Same guard as setSync(), scoped to what the updater actually changed so
      // a pre-existing legacy entry can still be read back and rewritten as-is.
      for (const [key, value] of Object.entries(values)) {
        if (!isFileBackedCredentialKey(key) || before[key] === value) continue;
        throw fileBackedCredentialWriteError(key);
      }
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
    const legacy = this.legacyStore;
    if (!legacy) throw new Error("Legacy credential store cannot be migrated.");
    let values: Record<string, string>;
    try {
      values = legacy.readAllForMigration();
    } catch {
      // An undecryptable legacy store must abort the migration, never migrate
      // an empty view of it.
      return null;
    }
    // `readAllForMigration()` is a non-rewriting read, and that read returns
    // `{}` instead of throwing when no available key decrypts the ciphertext.
    // Migrating that empty view would write an empty safeStorage file and then
    // delete credentials.json.enc AND .machine-key — destroying every
    // credential on the machine. Abort instead: nothing written, nothing
    // deleted, and the ciphertext stays recoverable.
    if (legacy.getLastReadState() === "unreadable") return null;
    return values;
  }

  private migrateLegacyStore(safeLockHeld: boolean): Record<string, string> | null {
    const migrate = () => withOptionalCredentialFileLock(this.legacyLockPath, this.lockPath, () => {
      const legacySafeStorageValues = this.readLegacySafeStorageFile();
      const legacyValues = legacySafeStorageValues ?? this.readLegacyEncryptedFileStore();
      if (!legacyValues) return null;
      // Only the AES file store is shared with the ADE brain and the CLI. A
      // legacy file that is ALREADY safeStorage-encrypted is Electron-only
      // whether it moves or not, so it keeps the original move-and-delete path.
      if (legacySafeStorageValues) {
        this.writeAll(legacyValues);
        this.removeLegacyFileStore();
        return legacyValues;
      }
      // The account session (and the sync bootstrap token) are read by the brain
      // and the CLI straight from the file store. They must not be moved into
      // the Electron-only safeStorage file, and while any of them are still
      // there the file store (and its machine key) must survive.
      const migrated: Record<string, string> = {};
      const retained: Record<string, string> = {};
      for (const [key, value] of Object.entries(legacyValues)) {
        if (isFileBackedCredentialKey(key)) retained[key] = value;
        else migrated[key] = value;
      }
      this.writeAll(migrated);
      if (Object.keys(retained).length === 0) {
        this.removeLegacyFileStore();
        return migrated;
      }
      // The file store survives for the retained keys, so every migrated key
      // now exists in BOTH files. Leaving the duplicates behind means the brain
      // and the CLI keep serving the stale file copy after the app rotates a
      // token, and revoked secrets stay at rest forever. Prune the file store
      // down to what it is still authoritative for. Nothing migrated means
      // nothing is duplicated, so the file is left byte-identical.
      if (Object.keys(migrated).length > 0) this.pruneLegacyFileStore(retained);
      return migrated;
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

  /**
   * Rewrites the legacy file store to only the keys it stays authoritative for.
   *
   * The migration holds the legacy store's own lock file (or, on the shared
   * path, the one lock covering both), and that lock is not reentrant — a plain
   * `legacyStore.updateSync()` here would block until the lock timeout and
   * throw. The prune therefore goes through the store's non-locking migration
   * seam, the same way the sibling deletes go straight to `fs`.
   */
  private pruneLegacyFileStore(retained: Record<string, string>): void {
    try {
      this.legacyStore?.pruneForMigration(retained);
    } catch {
      // Best effort: failing to prune only leaves the pre-existing duplicates
      // behind. It must never fail the read that triggered the migration.
    }
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
