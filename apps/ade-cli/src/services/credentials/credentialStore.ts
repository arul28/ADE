import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import {
  CREDENTIAL_FILE_LOCK_TIMEOUT_MS,
  CredentialFileStatWatcher,
  defaultLockPath,
  ensureDirMode700,
  ensureMode600,
  isEnoent,
  isEexist,
  isSamePath,
  readJsonObject,
  readJsonObjectAsync,
  unlinkIfExists,
  withCredentialFileLock,
  withOptionalCredentialFileLock,
  writeFileAtomic,
} from "./credentialFileIo";
import {
  clearQuarantineMarker,
  deleteQuarantinedStoreFile,
  quarantineCredentialFile,
  quarantineHasExpired,
  readCredentialStoreQuarantine,
  readQuarantinedStoreFile,
  writeQuarantineRecord,
  type CredentialStoreQuarantineRecord,
} from "./credentialStoreQuarantine";
import {
  invalidateDefaultOsBoundKeyMaterialCache,
  platformSupportsOsBoundKeyMaterial,
  readExistingOsBoundKeyMaterial,
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
 * Which key sealed a stored envelope.
 *
 * `machine` is the bare `.machine-key` file next to the ciphertext. `os` is that
 * key stretched with OS-held material (macOS keychain item / Windows DPAPI blob).
 *
 * ADE only ever WRITES `machine` for this store, and the reason is the whole
 * point of this module: `credentials.json.enc` is co-owned by processes that do
 * not have equal access to OS-held material. The ADE brain runs as a launchd
 * agent (or a Windows scheduled task) with no UI, so a keychain item whose ACL
 * belongs to the desktop app cannot be read by it — `security` fails closed and
 * the brain derives the bare machine key. The desktop app, meanwhile, reads that
 * item fine. A store sealed by either process under ITS binding is unreadable by
 * the other, and for the brain that used to mean a decrypt throw on every
 * startup, forever.
 *
 * `os` therefore survives only as a READ capability, so stores sealed by older
 * builds still open and can be converged back to `machine`. There is no writer.
 *
 * What that costs: an attacker who copies `~/.ade/secrets` off the machine gets
 * the ciphertext AND the key beside it. That was already true of every other
 * secret in that directory (`machine-identity-signing.json`,
 * `sync-cloud-relay.json` are plain JSON), and OS binding never protected
 * against the realistic attacker — anyone running as this user can ask the
 * keychain or DPAPI for the material directly. Single-writer secrets that want
 * real OS protection have a home already: the Electron-only safeStorage store
 * below.
 */
export type CredentialStoreBinding = "machine" | "os";

/**
 * Why the last synchronous read could not produce values. Coarse by design: it
 * is surfaced to product analytics so field incidence of the "brain cannot read
 * the credential file the app just wrote" class becomes measurable.
 */
export type CredentialStoreReadFailureReason =
  /** The ciphertext exists but no available key decrypts it. */
  | "decrypt_failure"
  /**
   * The envelope was sealed with OS-held key material this process cannot
   * obtain — an older build's `os` binding, read by a process (typically the
   * brain) that the keychain will not answer for. A PEER process may still be
   * able to open it, which is why this reason never counts as corruption.
   */
  | "no_os_key_material"
  /** The file exists but is not a recognised credential envelope. */
  | "store_format";

// Re-exported so consumers that only care about credential health — `ade
// doctor`, the desktop account bridge — have one import to reach for.
export {
  readCredentialStoreQuarantine,
  type CredentialStoreQuarantineRecord,
};

/** Bounds how often a store re-stats the quarantine marker on a clean read. */
const QUARANTINE_PROBE_INTERVAL_MS = 5_000;
/**
 * Lock budget for the deferred, best-effort rebind off the asynchronous read.
 *
 * The lock is acquired with a synchronous `Atomics.wait` spin, so whatever this
 * value is, the event loop stops for it — and the process that reaches this
 * path is the desktop main process, where that means IPC stops. The full 15 s
 * peer timeout is the wrong budget for work nobody is waiting on: if a peer
 * holds the lock right now, skipping costs nothing, because the next read
 * converges the store anyway.
 */
const REBIND_LOCK_TIMEOUT_MS = 250;

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
  /**
   * Which key sealed this file. Absent on envelopes written before ADE recorded
   * it, which is why every reader still has to be able to try both keys.
   *
   * Deliberately OUTSIDE the AAD and on `version: 1`: a build that predates this
   * field must keep decrypting files this one writes, or a downgrade turns into
   * the same dead-brain incident this field exists to end. That makes it an
   * unauthenticated hint, and it is safe as one — AES-GCM decides whether a key
   * is right, so a tampered hint can only cost a wasted decrypt attempt, never
   * accept the wrong key.
   */
  binding?: CredentialStoreBinding;
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
   * Why that read failed, when it did. The legacy store is the only thing that
   * knows: a store nothing on this machine can open is `no_os_key_material`
   * (a PEER process can still open it, so the credentials are not lost) and a
   * broken file is `store_format`. Reporting either as `decrypt_failure` sends
   * the user at the wrong repair.
   */
  getLastReadFailureReason(): CredentialStoreReadFailureReason | null;
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
 * Re-exported from the file-IO layer that actually enforces it, so a caller
 * pacing itself against the lock cannot drift from the real timeout.
 */
export const CREDENTIAL_STORE_LOCK_TIMEOUT_MS = CREDENTIAL_FILE_LOCK_TIMEOUT_MS;
const CREDENTIAL_CHANGE_POLL_INTERVAL_MS = 250;
/** Bounds OS key-material re-reads when a store keeps failing to decrypt. */
const KEY_MATERIAL_SELF_HEAL_INTERVAL_MS = 30_000;


function normalizeKey(key: string): string {
  const normalized = key.trim();
  if (!normalized.length) throw new Error("Credential key is required.");
  if (normalized.includes("\0")) throw new Error("Credential key cannot contain null bytes.");
  return normalized;
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

/**
 * The declared binding, or null when the envelope predates the field.
 *
 * An unrecognised value is read as "not declared" rather than rejected: the hint
 * is advisory, and a future binding name must not make an otherwise valid file
 * unreadable to this build.
 */
function readDeclaredBinding(raw: StoredCredentialEnvelope): CredentialStoreBinding | null {
  return raw.binding === "machine" || raw.binding === "os" ? raw.binding : null;
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

function serializeStore(
  values: Record<string, string>,
  machineKey: Buffer,
  binding: CredentialStoreBinding,
): StoredCredentialEnvelope {
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
    binding,
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
  /**
   * Could SOME process on this machine hold OS material for this store, even if
   * this one cannot? It decides whether ciphertext this process cannot open is
   * classified as recoverable-by-a-peer or as corruption.
   *
   * A property of the material source, not of the store — and injected rather
   * than read from `process.platform` at the point of use, because otherwise the
   * classification depends on the host the code happens to run on and cannot be
   * exercised on any other. Defaults to `platformSupportsOsBoundKeyMaterial()`.
   */
  peerMayHoldMaterial?: boolean;
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
  peerMayHoldMaterial: platformSupportsOsBoundKeyMaterial(),
};

/**
 * The source a health check uses: read-only, so inspecting a store can never
 * mint a keychain item or a DPAPI key file, and never spends the platform's
 * create budget doing it.
 */
const INSPECTION_KEY_MATERIAL_SOURCE: CredentialKeyMaterialSource = {
  read: readExistingOsBoundKeyMaterial,
  peerMayHoldMaterial: platformSupportsOsBoundKeyMaterial(),
};

type CredentialDecodeAttempt =
  | {
    ok: true;
    values: Record<string, string>;
    /** Which key actually opened it, so the caller knows whether to re-seal. */
    sealedBinding: CredentialStoreBinding;
  }
  | {
    ok: false;
    error: unknown;
    reason: CredentialStoreReadFailureReason;
    /**
     * True when a PEER process on this machine plausibly holds the key: the
     * envelope is (or may be) `os`-sealed and this process has no OS material.
     * Callers must never treat these as corruption — the desktop app opening
     * them is exactly how an already-broken machine heals itself.
     */
    recoverableByPeer: boolean;
  };

/**
 * One decrypt attempt against the keys this process can actually derive.
 *
 * Both keys are tried whenever both exist, ordered by the envelope's declared
 * binding, because the previous version's fixed "os key, then machine key"
 * order was the trapdoor: a process WITH keychain material could open a
 * machine-sealed store through the fallback and then re-seal it `os`, while a
 * process WITHOUT material had no fallback at all and was locked out for good.
 * Reading is symmetric now, and the only re-seal direction is toward `machine`
 * — the binding every co-owner of this file can derive.
 */
function decodeCredentialStore(
  raw: Record<string, unknown> | null,
  machineKey: Buffer,
  material: Buffer | null,
  peerMayHoldMaterial: boolean,
): CredentialDecodeAttempt {
  if (raw == null || Object.keys(raw).length === 0) {
    return { ok: true, values: {}, sealedBinding: "machine" };
  }
  if (!isStoredCredentialEnvelope(raw)) {
    return {
      ok: false,
      error: new Error("Unsupported ADE credential store format."),
      reason: "store_format",
      recoverableByPeer: false,
    };
  }
  const declared = readDeclaredBinding(raw);
  const osKey = deriveOsBoundCredentialKey(machineKey, material);
  const hasOsKey = !osKey.equals(machineKey);
  const osCandidate: Array<{ key: Buffer; binding: CredentialStoreBinding }> = hasOsKey
    ? [{ key: osKey, binding: "os" }]
    : [];
  const machineCandidate = { key: machineKey, binding: "machine" as const };
  // Declared binding only picks the order. A wrong hint costs one extra
  // decrypt, never a false "unreadable".
  const candidates = declared === "machine"
    ? [machineCandidate, ...osCandidate]
    : [...osCandidate, machineCandidate];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return {
        ok: true,
        values: deserializeStore(raw, candidate.key, { emptyOnDecryptFailure: false }),
        sealedBinding: candidate.binding,
      };
    } catch (error) {
      lastError = error;
    }
  }
  // No OS material here plus an envelope that is not declared machine-sealed is
  // the launchd-brain case, not a broken file: say so, and let the caller keep
  // the ciphertext for the peer that can open it.
  //
  // An undeclared binding is the common shape on the machines this fix exists
  // for — every store sealed before the field existed — so it has to guess. It
  // guesses "a peer may hold the key", because being wrong that way costs a
  // marker nobody acts on, while the other way costs the user their session.
  const mayBeOsSealed = !hasOsKey && declared !== "machine" && peerMayHoldMaterial;
  return {
    ok: false,
    error: lastError,
    reason: mayBeOsSealed ? "no_os_key_material" : "decrypt_failure",
    recoverableByPeer: mayBeOsSealed,
  };
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
  peerMayHoldMaterial: boolean;
}): CredentialDecodeAttempt | null {
  if (isSameKeyMaterial(args.refreshed, args.previous)) return null;
  const retried = decodeCredentialStore(
    args.raw,
    args.machineKey,
    args.refreshed,
    args.peerMayHoldMaterial,
  );
  return retried.ok ? retried : null;
}


/**
 * Health of a credential file, read without touching it.
 *
 * Deliberately non-creating: `ade doctor` runs this on machines whose brain is
 * already down, and a diagnostic that mints a machine key (or a keychain item)
 * changes the very state it was asked to describe.
 */
export type CredentialStoreHealth = {
  path: string;
  exists: boolean;
  state: CredentialStoreReadState;
  reason: CredentialStoreReadFailureReason | null;
  sealedBinding: CredentialStoreBinding | null;
  /** The declared binding, even when the file could not be opened. */
  declaredBinding: CredentialStoreBinding | null;
  quarantine: CredentialStoreQuarantineRecord | null;
};

export function inspectCredentialStoreHealth(args: {
  credentialsPath: string;
  machineKeyPath: string;
  keyMaterial?: CredentialKeyMaterialSource;
}): CredentialStoreHealth {
  const quarantine = readCredentialStoreQuarantine(args.credentialsPath);
  const base = {
    path: args.credentialsPath,
    declaredBinding: null as CredentialStoreBinding | null,
    quarantine,
  };
  let raw: Record<string, unknown> | null;
  try {
    raw = readJsonObject(args.credentialsPath);
  } catch {
    return { ...base, exists: true, state: "unreadable", reason: "store_format", sealedBinding: null };
  }
  if (!fs.existsSync(args.credentialsPath)) {
    return { ...base, exists: false, state: "missing", reason: null, sealedBinding: null };
  }
  if (raw == null) {
    // Valid JSON that is not an object (`readJsonObject` reports that as null).
    return { ...base, exists: true, state: "unreadable", reason: "store_format", sealedBinding: null };
  }
  const declaredBinding = isStoredCredentialEnvelope(raw) ? readDeclaredBinding(raw) : null;
  const machineKey = readMachineKeyIfExists(args.machineKeyPath);
  if (!machineKey) {
    // No key file at all next to real ciphertext: nothing on this machine can
    // open it, and creating one here would only hide that.
    return {
      ...base,
      declaredBinding,
      exists: true,
      state: "unreadable",
      reason: "decrypt_failure",
      sealedBinding: null,
    };
  }
  const keyMaterial = args.keyMaterial ?? INSPECTION_KEY_MATERIAL_SOURCE;
  let material: Buffer | null;
  try {
    material = keyMaterial.read(path.dirname(args.machineKeyPath));
  } catch {
    // Same reasoning as the store's own reader: a Windows DPAPI failure throws,
    // and a diagnostic that throws tells the user nothing.
    material = null;
  }
  const attempt = decodeCredentialStore(
    raw,
    machineKey,
    material,
    keyMaterial.peerMayHoldMaterial ?? platformSupportsOsBoundKeyMaterial(),
  );
  return attempt.ok
    ? {
      ...base,
      declaredBinding,
      exists: true,
      state: "available",
      reason: null,
      sealedBinding: attempt.sealedBinding,
    }
    : {
      ...base,
      declaredBinding,
      exists: true,
      state: "unreadable",
      reason: attempt.reason,
      sealedBinding: null,
    };
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
  private readonly peerMayHoldOsMaterial: boolean;
  private lastReadState: CredentialStoreReadState = "missing";
  private lastReadFailureReason: CredentialStoreReadFailureReason | null = null;
  private lastKeyMaterialSelfHealAt = 0;
  private lastQuarantineProbeAt = 0;
  private pendingRebind: NodeJS.Timeout | null = null;
  private lastAsyncKeyMaterial: Buffer | null = null;

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
    // A key-material read that THROWS must not escape a credential read. On
    // Windows `readOrCreateWindowsDpapiMaterial` throws for every DPAPI failure
    // — including a transient PowerShell cold-start timeout — and that
    // exception used to travel straight out of `getSync`, which on the brain's
    // startup path is a process exit and a launchd restart loop.
    //
    // Degrading to null is safe now in a way it was not before: no writer seals
    // with OS material any more, so "no material" cannot silently re-seal a
    // bound store unbound. It reads as `no_os_key_material`, which is the
    // recoverable classification, and the next read that does get material
    // merges anything that was set aside back in.
    this.readKeyMaterial = () => {
      try {
        return keyMaterial.read(keyBindingDir);
      } catch {
        return null;
      }
    };
    this.readKeyMaterialAsync = async () => {
      try {
        return keyMaterial.readAsync
          ? await keyMaterial.readAsync(keyBindingDir)
          : keyMaterial.read(keyBindingDir);
      } catch {
        return null;
      }
    };
    // An injected source owns its own cache lifetime, so self-heal is available
    // only when that source supplies the matching invalidation hook.
    this.invalidateKeyMaterial = keyMaterial.invalidate
      ? () => keyMaterial.invalidate?.(keyBindingDir)
      : null;
    this.peerMayHoldOsMaterial = keyMaterial.peerMayHoldMaterial
      ?? platformSupportsOsBoundKeyMaterial();
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
    return (await this.getWithReadState(key)).value;
  }

  /**
   * A read paired with the state that read produced. Prefer this over `get()`
   * followed by `getLastReadState()`: the latter answers about the store's most
   * recent read, which after an await is not necessarily this one.
   */
  async getWithReadState(
    key: string,
  ): Promise<{ value: string | null; state: CredentialStoreReadState }> {
    const normalized = normalizeKey(key);
    const { values, state } = await this.readAllAsync();
    return { value: values[normalized] ?? null, state };
  }

  async set(key: string, value: string): Promise<void> {
    this.setSync(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deleteSync(key);
  }

  getSync(key: string): string | null {
    const normalized = normalizeKey(key);
    // Locked because the read may re-seal an `os`-bound store to the machine
    // key (and merge a recovered quarantine back in), and those writes have to
    // exclude concurrent writers.
    return this.withLock(
      () => this.readAll({ forWrite: false, rebind: true })[normalized] ?? null,
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
      const values = this.readAll({ forWrite: true });
      values[normalized] = nextValue;
      this.writeAll(values);
    });
  }

  deleteSync(key: string): void {
    const normalized = normalizeKey(key);
    this.withLock(() => {
      const values = this.readAll({ forWrite: true });
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
      const values = this.readAll({ forWrite: true });
      const shouldWrite = updater(values);
      if (shouldWrite !== false) {
        this.writeAll(values);
      }
    });
  }

  /**
   * What the "Can't read your sign-in" surface actually runs.
   *
   * Forces the two self-healing steps a read only performs opportunistically —
   * converge an `os`-bound store to the machine key, and merge back anything a
   * peer process quarantined — and reports what state that left the store in, so
   * the caller can say "fixed" or "sign in again" instead of restarting a
   * service and hoping.
   */
  repairSync(): {
    state: CredentialStoreReadState;
    reason: CredentialStoreReadFailureReason | null;
    recoveredKeys: number;
    quarantine: CredentialStoreQuarantineRecord | null;
  } {
    return this.withLock(() => {
      // The probe throttle exists to keep ordinary reads cheap; an explicit
      // repair is the one caller that must never be throttled out.
      this.lastQuarantineProbeAt = 0;
      const before = Object.keys(this.readAll({ forWrite: false, rebind: false })).length;
      this.lastQuarantineProbeAt = 0;
      const after = Object.keys(this.readAll({ forWrite: false, rebind: true })).length;
      return {
        state: this.lastReadState,
        reason: this.lastReadFailureReason,
        recoveredKeys: Math.max(0, after - before),
        quarantine: readCredentialStoreQuarantine(this.credentialsPath),
      };
    });
  }

  readAllForMigration(): Record<string, string> {
    // No rebind: the migration may be about to delete this file entirely, and
    // re-sealing it first would only be write amplification.
    return this.readAll({ forWrite: false, rebind: false });
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
   * The one synchronous read. EVERY caller already holds this store's lock,
   * because a read can write: it re-seals an `os`-bound store to the machine
   * key, merges a recovered quarantine back in, and — in `forWrite` mode —
   * quarantines ciphertext it cannot open.
   *
   * `forWrite` says a write follows. It never changes how the file is decoded,
   * only what happens when decoding fails: a read can honestly report nothing,
   * but a write about to persist `{}` over real credentials cannot, so it moves
   * the unreadable file aside first. `rebind` opts out of the re-seal for a
   * caller that is about to delete the file anyway.
   */
  private readAll(
    args: { forWrite: boolean; rebind?: boolean },
  ): Record<string, string> {
    const credentialsExist = fs.existsSync(this.credentialsPath);
    let raw: Record<string, unknown> | null;
    try {
      raw = readJsonObject(this.credentialsPath);
    } catch (error) {
      return this.onUnreadable({
        error,
        reason: "store_format",
        recoverableByPeer: false,
        forWrite: args.forWrite,
      });
    }
    if (credentialsExist && (raw == null || Object.keys(raw).length === 0)) {
      // A file that exists but holds `{}`, `null`, or any non-object JSON.
      // `readJsonObject` reports both as "no keys", which decodes as an empty
      // store — and an empty store is writable, so a truncated or half-written
      // file would be silently replaced. The asynchronous path has always
      // rejected this shape; the synchronous one has to agree.
      return this.onUnreadable({
        error: new Error("Unsupported ADE credential store format."),
        reason: "store_format",
        recoverableByPeer: false,
        forWrite: args.forWrite,
      });
    }
    const machineKey = readOrCreateMachineKey(this.machineKeyPath);
    const material = this.readKeyMaterial();
    let attempt = decodeCredentialStore(raw, machineKey, material, this.peerMayHoldOsMaterial);
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
        peerMayHoldMaterial: this.peerMayHoldOsMaterial,
      });
      if (retried) attempt = retried;
    }
    if (!attempt.ok) {
      return this.onUnreadable({
        error: attempt.error,
        reason: attempt.reason,
        recoverableByPeer: attempt.recoverableByPeer,
        forWrite: args.forWrite,
      });
    }
    this.lastReadState = credentialsExist ? "available" : "missing";
    this.lastReadFailureReason = null;
    let values = attempt.values;
    if (args.rebind !== false) {
      // A store this process could open under the `os` binding is exactly the
      // one a launchd brain cannot: converge it to the binding every co-owner
      // derives. Only ever in this direction.
      if (attempt.sealedBinding !== "machine") {
        try {
          this.writeAll(values);
        } catch {
          // Best effort — the ciphertext still reads as it is.
        }
      }
      const recovered = this.recoverQuarantinedStore(values, machineKey, material);
      if (recovered) values = recovered;
    }
    return values;
  }

  /**
   * The single place an unopenable credential file is turned into a decision.
   *
   * A plain read reports nothing and says why. A read that a write depends on
   * cannot do that — persisting `{}` would replace real credentials with an
   * empty store — so it moves the ciphertext aside instead, records a marker,
   * and lets the caller proceed on an empty base. Nothing is ever deleted: the
   * "never write empty over real credentials" invariant is kept by preserving
   * the bytes, not by refusing to run. Refusing is what crash-looped the brain.
   */
  private onUnreadable(args: {
    error: unknown;
    reason: CredentialStoreReadFailureReason;
    recoverableByPeer: boolean;
    forWrite: boolean;
  }): Record<string, string> {
    this.lastReadState = "unreadable";
    this.lastReadFailureReason = args.reason;
    if (!args.forWrite) return {};
    // A failed quarantine is the one case that still has to fail closed: if the
    // ciphertext could not be copied aside, writing over it would destroy it.
    const record = quarantineCredentialFile({
      credentialsPath: this.credentialsPath,
      reason: args.reason,
      recoverable: args.recoverableByPeer,
    });
    if (record) {
      // Reset the live file here rather than leaving it to the caller's write.
      // Not every write path reaches one — `deleteSync` returns early when the
      // key is absent, and `updateSync` when the updater declines — and each of
      // those would otherwise quarantine the same unreadable file again on the
      // next call, one copy per attempt.
      this.writeAll({});
      this.lastQuarantineProbeAt = 0;
    }
    return {};
  }

  /**
   * Merges a previously quarantined store back in once some process on this
   * machine can decrypt it.
   *
   * This is the automatic half of the fix for machines already in the broken
   * state: the brain quarantines an `os`-sealed store it cannot read and boots
   * clean, then the desktop app — which CAN read it — puts the account session
   * back without anyone signing in again.
   *
   * Only keys the live store lacks are restored. The live values were written
   * after the quarantine, so they win; a token the user has since replaced must
   * not be resurrected. Returns the merged values, or null when nothing changed.
   */
  private recoverQuarantinedStore(
    values: Record<string, string>,
    machineKey: Buffer,
    material: Buffer | null,
  ): Record<string, string> | null {
    const record = this.readQuarantineRecordThrottled();
    if (!record) return null;
    if (!record.recoverable || quarantineHasExpired(record)) {
      // Nothing here will ever be recovered: stop advertising a pending repair,
      // but keep the ciphertext itself for diagnostics.
      if (quarantineHasExpired(record)) this.forgetQuarantine();
      return null;
    }
    let attempt: CredentialDecodeAttempt;
    try {
      attempt = decodeCredentialStore(
        readQuarantinedStoreFile(this.credentialsPath, record),
        machineKey,
        material,
        this.peerMayHoldOsMaterial,
      );
    } catch {
      return null;
    }
    if (!attempt.ok) {
      // This process HAS the OS material the quarantine was waiting for and
      // still cannot open the file — so no peer will. Say so, or every surface
      // keeps telling the user to open an app that has already tried.
      if (material) {
        writeQuarantineRecord(this.credentialsPath, { ...record, recoverable: false });
      }
      return null;
    }
    const merged = { ...values };
    let changed = false;
    for (const [key, value] of Object.entries(attempt.values)) {
      if (key in merged) continue;
      merged[key] = value;
      changed = true;
    }
    try {
      if (changed) this.writeAll(merged);
      // The quarantined copy is live credential ciphertext that this process can
      // decrypt. Once its contents are back in the store, keeping it is only
      // extra secret material at rest.
      deleteQuarantinedStoreFile(this.credentialsPath, record);
      this.forgetQuarantine();
    } catch {
      return changed ? merged : null;
    }
    return changed ? merged : null;
  }

  private readQuarantineRecordThrottled(): CredentialStoreQuarantineRecord | null {
    const now = Date.now();
    if (
      this.lastQuarantineProbeAt > 0
      && now - this.lastQuarantineProbeAt < QUARANTINE_PROBE_INTERVAL_MS
    ) {
      return null;
    }
    this.lastQuarantineProbeAt = now;
    return readCredentialStoreQuarantine(this.credentialsPath);
  }

  private forgetQuarantine(): void {
    clearQuarantineMarker(this.credentialsPath);
    this.lastQuarantineProbeAt = 0;
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

  /**
   * Returns the decoded values AND the state this read produced, because
   * `lastReadState` is a single field every reader overwrites. An async caller
   * can only consult it once its own read has resolved, by which point another
   * reader — App user authentication shares this store — may have moved it.
   * Capturing the verdict here, in the same step that records it, is what keeps
   * "no credential" and "a credential ADE cannot read" tellable apart.
   */
  private async readAllAsync(): Promise<{
    values: Record<string, string>;
    state: CredentialStoreReadState;
  }> {
    const { value: raw, exists: credentialsExist } = await readJsonObjectAsync(this.credentialsPath);
    if (!credentialsExist) {
      this.lastReadState = "missing";
      this.lastReadFailureReason = null;
      return { values: {}, state: "missing" };
    }
    if (!raw || Object.keys(raw).length === 0) {
      this.lastReadState = "unreadable";
      this.lastReadFailureReason = "store_format";
      return { values: {}, state: "unreadable" };
    }
    const machineKey = await readOrCreateMachineKeyAsync(this.machineKeyPath);
    const material = await this.readKeyMaterialAsync();
    let attempt = decodeCredentialStore(raw, machineKey, material, this.peerMayHoldOsMaterial);
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
        peerMayHoldMaterial: this.peerMayHoldOsMaterial,
      });
      if (retried) attempt = retried;
    }
    if (!attempt.ok) {
      // Never throws, and never quarantines: a read has nothing to protect by
      // failing, and the asynchronous path holds no lock to quarantine under.
      // The reason is what the caller needs, and it gets it.
      this.lastReadState = "unreadable";
      this.lastReadFailureReason = attempt.reason;
      return { values: {}, state: "unreadable" };
    }
    this.lastReadState = "available";
    this.lastReadFailureReason = null;
    if (attempt.sealedBinding !== "machine") this.scheduleRebindToMachineKey(material);
    return { values: attempt.values, state: "available" };
  }

  /**
   * The only seal this store performs. Always the machine key, always declared:
   * this file is co-owned by the desktop app, the brain and the CLI, and the
   * machine key is the one key all three can derive. See `CredentialStoreBinding`.
   */
  private writeAll(values: Record<string, string>): void {
    const machineKey = readOrCreateMachineKey(this.machineKeyPath);
    writeFileAtomic(
      this.credentialsPath,
      `${JSON.stringify(serializeStore(values, machineKey, "machine"), null, 2)}\n`,
    );
  }

  /**
   * Runs the rebind after the awaited read has returned.
   *
   * `rebindToMachineKeyUnderLock` acquires the file lock with a synchronous
   * spin, so calling it inline from the asynchronous path made the read block
   * the event loop until the lock was free. Nobody is waiting on this work — the
   * caller already has its plaintext values — so it goes off the awaited path
   * and takes a short lock budget instead of the peer timeout.
   */
  private scheduleRebindToMachineKey(material: Buffer | null): void {
    if (this.pendingRebind) clearTimeout(this.pendingRebind);
    this.lastAsyncKeyMaterial = material;
    const timer = setTimeout(() => {
      this.pendingRebind = null;
      this.rebindToMachineKeyUnderLock(material);
    }, 0);
    timer.unref?.();
    this.pendingRebind = timer;
  }

  /**
   * Runs a scheduled rebind now instead of on the next tick, the same way
   * `checkForChangesNow()` runs the production poller's comparison without
   * waiting for its interval.
   */
  flushPendingRebindNow(): void {
    if (!this.pendingRebind) return;
    clearTimeout(this.pendingRebind);
    this.pendingRebind = null;
    this.rebindToMachineKeyUnderLock(this.lastAsyncKeyMaterial);
  }

  /**
   * Re-seals an `os`-bound store to the machine key under this store's lock, for
   * an asynchronous caller that does NOT already hold it.
   *
   * The re-read inside the lock is the point: a peer may have converged the file
   * while this reader waited, and rewriting from the stale `raw` would undo it.
   *
   * `material` is handed in rather than re-read so the asynchronous caller never
   * touches the synchronous key-material reader — on Windows that is a blocking
   * PowerShell spawn, and the async path exists precisely to avoid it.
   *
   * Best effort: failing here only leaves the ciphertext bound as it was, which
   * this process can still read, so it must never fail the read that triggered it.
   */
  private rebindToMachineKeyUnderLock(material: Buffer | null): void {
    try {
      this.withLock(() => {
        const machineKey = readOrCreateMachineKey(this.machineKeyPath);
        const raw = readJsonObject(this.credentialsPath);
        const attempt = decodeCredentialStore(
          raw,
          machineKey,
          material,
          this.peerMayHoldOsMaterial,
        );
        if (!attempt.ok || attempt.sealedBinding === "machine") return;
        this.writeAll(attempt.values);
      }, { timeoutMs: REBIND_LOCK_TIMEOUT_MS });
    } catch {
      // A peer holds the lock, or the rebind failed: the ciphertext still reads
      // as it is, and the next read converges it.
    }
  }

  private withLock<T>(fn: () => T, options: { timeoutMs?: number } = {}): T {
    return withCredentialFileLock(this.lockPath, fn, options);
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
  /**
   * Result of the most recent read, for the same reason the file store records
   * one: a read that cannot open the ciphertext still has to return SOMETHING,
   * and the only branch here that returns `{}` rather than throwing is the
   * aborted legacy migration below. Without this, a caller cannot tell that
   * empty view from a machine that was never signed in — and telling a user
   * "not connected" when the truth is "not readable" invites them to reconnect
   * over credentials that are still on disk.
   */
  private lastReadState: CredentialStoreReadState = "missing";
  private lastReadFailureReason: CredentialStoreReadFailureReason | null = null;

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

  getLastReadState(): CredentialStoreReadState {
    return this.lastReadState;
  }

  getLastReadFailureReason(): CredentialStoreReadFailureReason | null {
    return this.lastReadFailureReason;
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
        if (legacyValues) return this.recordRead(legacyValues, "available");
        // No safeStorage file AND no migratable legacy values. That is "missing"
        // UNLESS the legacy store told us it could not decrypt what is there —
        // the migration aborts on exactly that case (readLegacyEncryptedFileStore)
        // and returning `{}` without saying so is the masking bug.
        //
        // The legacy store's OWN reason is carried across rather than assumed:
        // an `os`-sealed store this process cannot open is `no_os_key_material`,
        // which a peer process can still recover from, and calling that a
        // decrypt failure offers a repair that throws the session away.
        const legacy = this.legacyStore;
        return legacy?.getLastReadState() === "unreadable"
          ? this.recordRead({}, "unreadable", legacy.getLastReadFailureReason() ?? "decrypt_failure")
          : this.recordRead({}, "missing");
      }
      this.recordRead({}, "unreadable", "store_format");
      throw error;
    }
    try {
      const decrypted = this.safeStorage.decryptString(payload.encrypted);
      return this.recordRead(normalizeStoredCredentialValues(JSON.parse(decrypted)), "available");
    } catch (error: unknown) {
      if (!payload.hasMagic && isStoredCredentialEnvelopeBuffer(payload.encrypted)) {
        const legacyValues = this.migrateLegacyStore(args.safeLockHeld === true);
        if (legacyValues) return this.recordRead(legacyValues, "available");
      }
      this.recordRead({}, "unreadable", "decrypt_failure");
      throw error;
    }
  }

  private recordRead(
    values: Record<string, string>,
    state: CredentialStoreReadState,
    reason: CredentialStoreReadFailureReason | null = null,
  ): Record<string, string> {
    this.lastReadState = state;
    this.lastReadFailureReason = state === "unreadable" ? reason : null;
    return values;
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
