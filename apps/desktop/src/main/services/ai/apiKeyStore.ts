import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { SafeStorage } from "electron";
import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { MachineApiKeySource, MachineApiKeyStatus } from "../../../shared/types/config";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type { AccountVaultBridge } from "../account/accountVaultBridge";
import type { Logger } from "../logging/logger";

// electron.safeStorage is only available inside an Electron main process.
// When this module is bundled into the ADE CLI headless runtime, `electron`
// is not present. Gracefully degrade so the CLI can start.
let safeStorage: SafeStorage | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  safeStorage = require("electron").safeStorage;
} catch (err) {
  // Not running inside Electron — secure storage unavailable.
  // Log at debug level so silent failures don't hide useful diagnostics.
  if (typeof process !== "undefined" && process.env.DEBUG) {
    console.debug("[apiKeyStore] electron.safeStorage unavailable:", err);
  }
}

type StoredKeys = Record<string, string>;

export type ApiKeyCredentialStore = SyncCredentialStore;

export type InitApiKeyStoreOptions = {
  credentialStore?: ApiKeyCredentialStore | null;
  getAccountVault?: () => AccountVaultBridge | null | undefined;
  logger?: Pick<Logger, "warn"> | null;
};

export type InitMachineApiKeyStoreOptions = {
  credentialStore: ApiKeyCredentialStore | null;
};

export type ApiKeyStoreStatus = {
  secureStorageAvailable: boolean;
  macosKeychainAvailable: boolean;
  macosKeychainService: string | null;
  macosKeychainError: string | null;
  encryptedStorePath: string | null;
  legacyPlaintextDetected: boolean;
  legacyPlaintextPath: string | null;
  decryptionFailed: boolean;
};

const ENV_KEY_PROVIDERS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  xai: "XAI_API_KEY",
  groq: "GROQ_API_KEY",
  together: "TOGETHER_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  cursor: "CURSOR_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
};

const MACOS_SECURITY_BIN = "/usr/bin/security";
const MACOS_KEYCHAIN_SERVICE = "com.ade.desktop.api-keys.v1";
const MACOS_KEYCHAIN_PROVIDER_INDEX_ACCOUNT = "__ade_provider_index__";
const CREDENTIAL_LEGACY_KEYCHAIN_MIGRATED_KEY = "ai.credentials.legacy_keychain_migrated.v1";
const CREDENTIAL_LEGACY_PROJECTS_MIGRATED_KEY = "ai.credentials.legacy_projects_migrated.v1";
const MACOS_KEYCHAIN_MISSING_PATTERNS = [
  /could not be found/i,
  /item could not be found/i,
  /the specified item could not be found/i,
];
const SECURITY_TIMEOUT_MS = 5_000;
const CREDENTIAL_PROVIDER_INDEX_KEY = "ai.api_key.index.v1";

let getAccountVault: (() => AccountVaultBridge | null | undefined) | null = null;
let vaultLogger: Pick<Logger, "warn"> | null = null;

function describeVaultFailure(detail: unknown): string {
  if (detail instanceof Error) return detail.message;
  if (detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string") {
    return detail.message;
  }
  return String(detail ?? "unknown error");
}

function logVaultFailure(operation: string, provider: string, detail: unknown): void {
  vaultLogger?.warn("ai.api_key_vault_sync_failed", {
    operation,
    provider,
    error: describeVaultFailure(detail),
  });
}

function resolveAccountVault(operation: string, provider: string): AccountVaultBridge | null {
  try {
    return getAccountVault?.() ?? null;
  } catch (error) {
    logVaultFailure(operation, provider, error);
    return null;
  }
}

function fireAndForgetVaultCall(
  operation: "set" | "remove",
  provider: string,
  call: (vault: AccountVaultBridge) => Promise<unknown>,
): void {
  const vault = resolveAccountVault(operation, provider);
  if (!vault) return;

  let pending: Promise<unknown>;
  try {
    pending = call(vault);
  } catch (error) {
    logVaultFailure(operation, provider, error);
    return;
  }

  void Promise.resolve(pending).then((result) => {
    if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) {
      logVaultFailure(operation, provider, result);
    }
  }).catch((error: unknown) => {
    logVaultFailure(operation, provider, error);
  });
}

/**
 * Everything the store resolves from one root, held in one object.
 *
 * One object rather than nine separate `let`s because there are two of these
 * alive at once — the project scope and the machine scope — and every helper
 * below takes the one it must act on as its first argument. As separate globals
 * the two scopes could only exist by swapping the globals in and out, which
 * made "which store am I reading?" a property of the call stack rather than of
 * the call.
 */
type ApiKeyScopeState = {
  storePath: string | null;
  legacyStorePath: string | null;
  projectRootPath: string | null;
  credentialStore: ApiKeyCredentialStore | null;
  cache: StoredKeys | null;
  decryptionFailed: boolean;
  macosKeychainError: string | null;
  missingMacosKeychainProviders: Set<string>;
  missingCredentialProviders: Set<string>;
  /**
   * Files whose mtime/size decide whether `cache` is still the truth.
   *
   * Empty for the project scope, which has exactly one writer in one process.
   * The MACHINE scope does not: the desktop app, the `ade` CLI and the project
   * runtime all read the same `~/.ade/secrets` files, so a key stored by one of
   * them is invisible to the others' in-memory cache for the life of the
   * process. That is not theoretical — it is why a key saved in Settings left
   * the runtime still answering "no OpenAI key on this machine".
   */
  watchedPaths: readonly string[];
  /** The stamp `cache` was read at; null when nothing is cached. */
  cacheStamp: string | null;
};

function emptyScopeState(): ApiKeyScopeState {
  return {
    storePath: null,
    legacyStorePath: null,
    projectRootPath: null,
    credentialStore: null,
    cache: null,
    decryptionFailed: false,
    macosKeychainError: null,
    missingMacosKeychainProviders: new Set<string>(),
    missingCredentialProviders: new Set<string>(),
    watchedPaths: [],
    cacheStamp: null,
  };
}

/**
 * A cheap fingerprint of the files a cached store was read from.
 *
 * Never the contents, which are encrypted and would have to be decrypted to
 * compare. Size and mtime are the obvious pair, but a same-size rewrite inside
 * one mtime tick is invisible to them on a coarse-granularity filesystem — and
 * a replaced (rather than rewritten) file is exactly what an atomic
 * write-then-rename produces. The inode catches the rename, and ctime moves on
 * a metadata change even when mtime is quantised. On Windows `ctimeMs` is the
 * creation time rather than a change time, which still distinguishes a replaced
 * file; it is combined with size and mtime rather than trusted alone.
 *
 * A missing file is a value too ("-"), so deleting the store invalidates as
 * loudly as writing it. Every call is `statSync` on at most four small paths,
 * which is the budget a per-read freshness check has.
 */
function readStoreStamp(paths: readonly string[]): string {
  const parts: string[] = [];
  for (const candidate of paths) {
    try {
      const stat = fs.statSync(candidate);
      parts.push(`${stat.size}:${stat.mtimeMs}:${stat.ino}:${stat.ctimeMs}`);
    } catch {
      parts.push("-");
    }
  }
  return parts.join("|");
}

/** The project the app currently has open. Rebuilt by `initApiKeyStore`. */
let projectScope: ApiKeyScopeState = emptyScopeState();
/** How the current ADE-stored Cursor key was written. Lost on process restart;
 *  cursorSdkAuth reconstructs from Cursor.auth.status() + the SDK auth file. */
let cursorKeyOrigin: "oauth" | "pasted" | null = null;

export function __setSafeStorageForTests(next: SafeStorage | null): void {
  safeStorage = next;
  projectScope.cache = null;
  projectScope.missingMacosKeychainProviders = new Set<string>();
  machineScopeState = null;
}

function isSecureStorageAvailable(): boolean {
  return Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === "function" && safeStorage.isEncryptionAvailable());
}

function isMacosKeychainAvailable(): boolean {
  if (process.env.ADE_API_KEY_STORE_DISABLE_KEYCHAIN === "1") return false;
  if (process.env.NODE_ENV === "test" && process.env.ADE_API_KEY_STORE_FORCE_KEYCHAIN === "1") return true;
  return process.platform === "darwin" && fs.existsSync(MACOS_SECURITY_BIN);
}

function isPersistentSecureStorageAvailable(scope: ApiKeyScopeState): boolean {
  if (scope.credentialStore) return true;
  return isSecureStorageAvailable();
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function normalizeStoredKeys(value: unknown): StoredKeys {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: StoredKeys = {};
  for (const [provider, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue !== "string") continue;
    const normalizedProvider = normalizeProvider(provider);
    const normalizedKey = rawValue.trim();
    if (!normalizedProvider.length || !normalizedKey.length) continue;
    out[normalizedProvider] = normalizedKey;
  }
  return out;
}

function ensureInitialized(scope: ApiKeyScopeState): void {
  if (!scope.storePath || !scope.legacyStorePath) {
    throw new Error("API key store not initialized. Call initApiKeyStore first.");
  }
}

type SecurityResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
};

function runSecurity(args: string[]): SecurityResult {
  const result = spawnSync(MACOS_SECURITY_BIN, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SECURITY_TIMEOUT_MS,
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : result.error?.message ?? "",
    status: typeof result.status === "number" ? result.status : null,
  };
}

function securityMissing(result: SecurityResult): boolean {
  if (result.status === 44) return true;
  return MACOS_KEYCHAIN_MISSING_PATTERNS.some((pattern) => pattern.test(result.stderr));
}

function rememberKeychainError(scope: ApiKeyScopeState, action: string, result: SecurityResult): void {
  const detail = result.stderr.trim().split(/\r?\n/)[0] || `status ${result.status ?? "unknown"}`;
  scope.macosKeychainError = `macOS Keychain ${action} failed: ${detail}`;
}

function clearKeychainError(scope: ApiKeyScopeState): void {
  scope.macosKeychainError = null;
}

function trimTrailingNewline(value: string): string {
  return value.replace(/(?:\r?\n)+$/, "");
}

function readMacosKeychainSecret(scope: ApiKeyScopeState, account: string): string | null {
  if (!isMacosKeychainAvailable()) return null;
  const result = runSecurity([
    "find-generic-password",
    "-a",
    account,
    "-s",
    MACOS_KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (result.ok) {
    clearKeychainError(scope);
    const value = trimTrailingNewline(result.stdout).trim();
    return value.length ? value : null;
  }
  if (!securityMissing(result)) {
    rememberKeychainError(scope, "read", result);
  }
  return null;
}

function deleteMacosKeychainSecret(scope: ApiKeyScopeState, account: string): void {
  if (!isMacosKeychainAvailable()) return;
  const result = runSecurity([
    "delete-generic-password",
    "-a",
    account,
    "-s",
    MACOS_KEYCHAIN_SERVICE,
  ]);
  if (result.ok || securityMissing(result)) {
    clearKeychainError(scope);
    return;
  }
  rememberKeychainError(scope, "delete", result);
  throw new Error(scope.macosKeychainError ?? "macOS Keychain delete failed.");
}

function normalizeProviderList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const providers = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const provider = raw.trim().toLowerCase();
    if (provider.length) providers.add(provider);
  }
  return Array.from(providers).sort();
}

function credentialProviderKey(provider: string): string {
  return `ai.api_key.${provider}.v1`;
}

function readCredentialSecret(scope: ApiKeyScopeState, key: string): string | null {
  const store = scope.credentialStore;
  if (!store) return null;
  try {
    const value = store.getSync(key);
    scope.decryptionFailed = false;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  } catch {
    scope.decryptionFailed = true;
    return null;
  }
}

function writeCredentialSecret(scope: ApiKeyScopeState, key: string, value: string): void {
  const store = scope.credentialStore;
  if (!store) return;
  store.setSync(key, value);
  scope.decryptionFailed = false;
}

function deleteCredentialSecret(scope: ApiKeyScopeState, key: string): void {
  const store = scope.credentialStore;
  if (!store) return;
  store.deleteSync(key);
  scope.decryptionFailed = false;
}

function readCredentialProviderIndex(scope: ApiKeyScopeState): { exists: boolean; providers: string[] } {
  const raw = readCredentialSecret(scope, CREDENTIAL_PROVIDER_INDEX_KEY);
  if (!raw) return { exists: false, providers: [] };
  try {
    return { exists: true, providers: normalizeProviderList(JSON.parse(raw)) };
  } catch {
    return { exists: true, providers: [] };
  }
}

function writeCredentialProviderIndex(scope: ApiKeyScopeState, providers: Iterable<string>): void {
  writeCredentialSecret(
    scope,
    CREDENTIAL_PROVIDER_INDEX_KEY,
    JSON.stringify(normalizeProviderList(Array.from(providers))),
  );
}

function readCredentialLegacyMigratedProjectRoots(scope: ApiKeyScopeState): Set<string> {
  const raw = readCredentialSecret(scope, CREDENTIAL_LEGACY_PROJECTS_MIGRATED_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    const roots = parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => path.resolve(entry));
    return new Set(roots);
  } catch {
    return new Set();
  }
}

function writeCredentialLegacyMigratedProjectRoots(
  scope: ApiKeyScopeState,
  projectRoots: Iterable<string>,
): void {
  const normalized = Array.from(new Set(Array.from(projectRoots).map((entry) => path.resolve(entry)))).sort();
  writeCredentialSecret(scope, CREDENTIAL_LEGACY_PROJECTS_MIGRATED_KEY, JSON.stringify(normalized));
}

function isCredentialLegacyKeychainMigrated(scope: ApiKeyScopeState): boolean {
  return Boolean(readCredentialSecret(scope, CREDENTIAL_LEGACY_KEYCHAIN_MIGRATED_KEY));
}

function markCredentialLegacyKeychainMigrated(scope: ApiKeyScopeState): void {
  writeCredentialSecret(scope, CREDENTIAL_LEGACY_KEYCHAIN_MIGRATED_KEY, new Date().toISOString());
}

function readCredentialStore(scope: ApiKeyScopeState, providerCandidates: Iterable<string>): StoredKeys {
  const out: StoredKeys = {};
  for (const provider of providerCandidates) {
    const normalizedProvider = normalizeProvider(provider);
    if (!normalizedProvider.length) continue;
    const value = readCredentialSecret(scope, credentialProviderKey(normalizedProvider));
    if (value) out[normalizedProvider] = value;
  }
  return out;
}

function mergeLegacyValuesIntoCredentialStore(
  scope: ApiKeyScopeState,
  currentStore: StoredKeys,
  legacyStore: StoredKeys,
): StoredKeys {
  const nextStore = { ...currentStore };
  const changedProviders = new Set<string>();
  for (const [provider, rawValue] of Object.entries(legacyStore)) {
    const normalizedProvider = normalizeProvider(provider);
    const value = rawValue.trim();
    if (!normalizedProvider.length || !value.length || nextStore[normalizedProvider]) continue;
    writeCredentialSecret(scope, credentialProviderKey(normalizedProvider), value);
    nextStore[normalizedProvider] = value;
    changedProviders.add(normalizedProvider);
  }
  if (changedProviders.size) {
    const index = readCredentialProviderIndex(scope);
    writeCredentialProviderIndex(scope, new Set([...index.providers, ...Object.keys(nextStore)]));
  }
  return nextStore;
}

function migrateLegacyProjectStoreIntoCredentialStore(
  scope: ApiKeyScopeState,
  currentStore: StoredKeys,
): StoredKeys {
  if (!scope.projectRootPath) return currentStore;
  const migratedProjectRoots = readCredentialLegacyMigratedProjectRoots(scope);
  const normalizedProjectRoot = path.resolve(scope.projectRootPath);
  if (migratedProjectRoots.has(normalizedProjectRoot)) return currentStore;

  const hadEncryptedStore = Boolean(scope.storePath && fs.existsSync(scope.storePath));
  const legacyStore = loadEncryptedStore(scope);
  const migrationComplete = !hadEncryptedStore || !scope.decryptionFailed;
  const nextStore = mergeLegacyValuesIntoCredentialStore(scope, currentStore, legacyStore);

  if (migrationComplete) {
    migratedProjectRoots.add(normalizedProjectRoot);
    writeCredentialLegacyMigratedProjectRoots(scope, migratedProjectRoots);
  }
  return nextStore;
}

function migrateLegacyKeychainIntoCredentialStore(
  scope: ApiKeyScopeState,
  currentStore: StoredKeys,
): StoredKeys {
  if (isCredentialLegacyKeychainMigrated(scope)) return currentStore;
  if (!isMacosKeychainAvailable()) return currentStore;

  const index = readMacosKeychainProviderIndex(scope);
  const providerCandidates = new Set([
    ...index.providers,
    ...Object.keys(ENV_KEY_PROVIDERS),
  ]);
  const keychainStore = readMacosKeychainStore(scope, providerCandidates);
  const nextStore = mergeLegacyValuesIntoCredentialStore(scope, currentStore, keychainStore);
  markCredentialLegacyKeychainMigrated(scope);
  return nextStore;
}

function migrateLegacyStoresIntoCredentialStore(
  scope: ApiKeyScopeState,
  currentStore: StoredKeys,
): StoredKeys {
  let nextStore = currentStore;
  try {
    nextStore = migrateLegacyKeychainIntoCredentialStore(scope, nextStore);
  } catch {
    // Keep the machine credential store usable even if a legacy Keychain read
    // or write is blocked. The legacy copy remains available for a later retry.
  }
  try {
    nextStore = migrateLegacyProjectStoreIntoCredentialStore(scope, nextStore);
  } catch {
    // Best effort. A failed migration must not block app or runtime startup.
  }
  return nextStore;
}

function readMacosKeychainProviderIndex(scope: ApiKeyScopeState): { exists: boolean; providers: string[] } {
  const raw = readMacosKeychainSecret(scope, MACOS_KEYCHAIN_PROVIDER_INDEX_ACCOUNT);
  if (!raw) return { exists: false, providers: [] };
  try {
    return { exists: true, providers: normalizeProviderList(JSON.parse(raw)) };
  } catch {
    scope.macosKeychainError = "macOS Keychain provider index is unreadable.";
    return { exists: true, providers: [] };
  }
}

function readMacosKeychainStore(scope: ApiKeyScopeState, providerCandidates: Iterable<string>): StoredKeys {
  const out: StoredKeys = {};
  if (!isMacosKeychainAvailable()) return out;
  for (const provider of providerCandidates) {
    if (provider === MACOS_KEYCHAIN_PROVIDER_INDEX_ACCOUNT) continue;
    const value = readMacosKeychainSecret(scope, provider);
    if (value) out[provider] = value;
  }
  return out;
}

function canPersistEncryptedStore(scope: ApiKeyScopeState): boolean {
  return Boolean(scope.storePath) && isSecureStorageAvailable();
}

function loadEncryptedStore(scope: ApiKeyScopeState): StoredKeys {
  ensureInitialized(scope);

  if (!scope.storePath || !scope.legacyStorePath) {
    return {};
  }

  if (!fs.existsSync(scope.storePath)) {
    scope.decryptionFailed = false;
    return {};
  }

  if (!isSecureStorageAvailable()) {
    scope.decryptionFailed = true;
    return {};
  }

  try {
    const raw = fs.readFileSync(scope.storePath);
    const decrypted = safeStorage!.decryptString(raw);
    scope.decryptionFailed = false;
    return normalizeStoredKeys(JSON.parse(decrypted));
  } catch {
    scope.decryptionFailed = true;
    return {};
  }
}

function deleteMacosKeychainSecretBestEffort(scope: ApiKeyScopeState, account: string): void {
  try {
    deleteMacosKeychainSecret(scope, account);
  } catch {
    // Legacy Keychain cleanup should not block writes to the active encrypted
    // store. A stale Keychain copy is still superseded by the encrypted value.
  }
}

function migrateLegacyMacosKeychainIntoEncryptedStore(
  scope: ApiKeyScopeState,
  encryptedStore: StoredKeys,
): StoredKeys {
  if (!canPersistEncryptedStore(scope) || !isMacosKeychainAvailable()) return encryptedStore;

  const index = readMacosKeychainProviderIndex(scope);
  const providerCandidates = index.exists ? index.providers : Object.keys(encryptedStore);
  if (providerCandidates.length === 0) return encryptedStore;

  const keychainStore = readMacosKeychainStore(scope, providerCandidates);
  if (Object.keys(keychainStore).length === 0) return encryptedStore;

  const nextStore = { ...keychainStore, ...encryptedStore };
  persistEncryptedStore(scope, nextStore);
  scope.decryptionFailed = false;
  return nextStore;
}

/**
 * Re-stamp the cache after THIS process wrote the store.
 *
 * Without it every write invalidates the writer's own cache on the next read —
 * the file it just wrote has a new mtime — and the store is decrypted again to
 * learn what it already knows. Worse for the credential tier, where a write
 * mutates the cached map in place rather than replacing it.
 */
function noteStoreWriteCommitted(scope: ApiKeyScopeState): void {
  if (!scope.watchedPaths.length) return;
  scope.cacheStamp = readStoreStamp(scope.watchedPaths);
}

function ensureStore(scope: ApiKeyScopeState): StoredKeys {
  // A scope with no watched paths has one writer in one process, so its cache
  // can only go stale through a path that already invalidates it by hand.
  const stamp = scope.watchedPaths.length ? readStoreStamp(scope.watchedPaths) : null;
  if (scope.cache && (stamp === null || stamp === scope.cacheStamp)) return scope.cache;
  if (scope.cache) {
    // Another process wrote the store. Drop what we read and read it again.
    //
    // `missingCredentialProviders` goes with it — it records "the store had no
    // key for this provider", which is exactly the answer that just changed.
    // `missingMacosKeychainProviders` deliberately does NOT: that one records
    // "this process deleted the Keychain copy", which no external write undoes,
    // and clearing it would resurrect a stale Keychain value.
    scope.cache = null;
    scope.missingCredentialProviders = new Set<string>();
  }
  scope.cacheStamp = stamp;
  ensureInitialized(scope);

  if (scope.credentialStore) {
    const index = readCredentialProviderIndex(scope);
    const credentialValues = index.exists ? readCredentialStore(scope, index.providers) : {};
    scope.cache = migrateLegacyStoresIntoCredentialStore(scope, credentialValues);
    return scope.cache;
  }

  const encryptedStore = loadEncryptedStore(scope);
  if (isMacosKeychainAvailable()) {
    if (canPersistEncryptedStore(scope)) {
      scope.cache = migrateLegacyMacosKeychainIntoEncryptedStore(scope, encryptedStore);
      return scope.cache;
    }

    const index = readMacosKeychainProviderIndex(scope);
    scope.cache = index.exists ? readMacosKeychainStore(scope, index.providers) : encryptedStore;
    return scope.cache;
  }

  scope.cache = encryptedStore;
  return scope.cache;
}

function persistEncryptedStore(scope: ApiKeyScopeState, nextStore: StoredKeys = scope.cache ?? {}): void {
  if (!scope.storePath) return;
  if (!isSecureStorageAvailable()) {
    throw new Error("OS secure storage is unavailable. Cannot persist API keys.");
  }
  fs.mkdirSync(path.dirname(scope.storePath), { recursive: true });
  const encrypted = safeStorage!.encryptString(JSON.stringify(nextStore));
  fs.writeFileSync(scope.storePath, encrypted);
  try {
    fs.chmodSync(scope.storePath, 0o600);
  } catch {
    // Best effort
  }
  noteStoreWriteCommitted(scope);
}

export function initApiKeyStore(projectRoot: string, options: InitApiKeyStoreOptions = {}): void {
  const layout = resolveAdeLayout(projectRoot);
  // Built from the factory rather than field by field, so a tenth field has one
  // place to be added and not three.
  projectScope = {
    ...emptyScopeState(),
    projectRootPath: path.resolve(projectRoot),
    storePath: layout.apiKeysPath,
    legacyStorePath: layout.legacyApiKeysPath,
    credentialStore: options.credentialStore ?? null,
  };
  getAccountVault = options.getAccountVault ?? null;
  vaultLogger = options.logger ?? null;
  cursorKeyOrigin = null;
  // A re-init can hand over a different credential store instance. The machine
  // scope may be borrowing the project's one (when no machine store was
  // registered), so its cached view is dropped here rather than left pointing
  // at the previous project's wiring.
  machineScopeState = null;
}

// ─── Machine-scoped keys ─────────────────────────────────────────────────────
//
// Some keys are not the project's. `initApiKeyStore` resolves through
// `resolveAdeLayout(projectRoot)`, so the encrypted fallback lands in
// `<project>/.ade/secrets` and a key pasted once stops existing the moment the
// user opens a different repo. The CTO voice key pays for calls THIS MACHINE
// makes; scoping it to a project would mean asking the same person for the same
// secret in every repo they open.
//
// This is the same store, read in the same three tiers (credential store →
// macOS Keychain → env var), with two differences: the encrypted fallback lives
// in the machine ADE home (`~/.ade/secrets`, or `$ADE_HOME`), and the
// per-project legacy migration — the one step that makes a key follow a
// project — never runs.

let machineScopeState: ApiKeyScopeState | null = null;
/**
 * The credential store machine-scoped keys belong in, registered once at app
 * start by `initMachineApiKeyStore`.
 *
 * It must be the SHARED file store (`credentials.json.enc`) rather than the
 * desktop's safeStorage-primary routed store: a machine key exists to be read
 * by the headless runtime and the `ade` CLI, neither of which can decrypt an
 * Electron safeStorage file. It is registered at app start rather than per
 * project because a window with no project bound, a remote-bound window and
 * the in-process mode all reach these functions, and every one of them must
 * write a store the runtime can read.
 */
let machineCredentialStore: ApiKeyCredentialStore | null = null;

/** Memoised so module load stays free of layout resolution. */
let machineApiKeyFileNames: { encrypted: string; legacy: string } | null = null;

/**
 * The api-key file names, taken from the same layout factory the project scope
 * resolves through, so the two scopes cannot drift apart. Only the basenames
 * are borrowed — the machine scope puts them in the machine secrets dir.
 */
function resolveApiKeyFileNames(): { encrypted: string; legacy: string } {
  if (machineApiKeyFileNames) return machineApiKeyFileNames;
  const probeLayout = resolveAdeLayout(path.join(path.sep, "__ade_api_key_layout_probe__"));
  machineApiKeyFileNames = {
    encrypted: path.basename(probeLayout.apiKeysPath),
    legacy: path.basename(probeLayout.legacyApiKeysPath),
  };
  return machineApiKeyFileNames;
}

function createMachineScopeState(): ApiKeyScopeState {
  const { secretsDir } = resolveMachineAdeLayout();
  const fileNames = resolveApiKeyFileNames();
  const storePath = path.join(secretsDir, fileNames.encrypted);
  const legacyStorePath = path.join(secretsDir, fileNames.legacy);
  // `projectRootPath` stays at the factory's null on purpose:
  // `migrateLegacyProjectStoreIntoCredentialStore` is what pulls a project's
  // `.ade/secrets` into the credential store, and a machine-scoped read must
  // never touch a project directory.
  return {
    ...emptyScopeState(),
    storePath,
    legacyStorePath,
    // Every door into this machine's secrets: the encrypted key fallback and
    // its legacy plaintext neighbour, plus both credential-store files — the
    // shared one the CLI and the brain co-own (`credentials.json.enc`) and the
    // Electron-only safeStorage one the desktop app may write
    // (`credentials.safe.enc`). A write through any of them must be visible to
    // a process that already cached the store.
    watchedPaths: [
      storePath,
      legacyStorePath,
      path.join(secretsDir, "credentials.json.enc"),
      path.join(secretsDir, "credentials.safe.enc"),
    ],
  };
}

/**
 * The machine-scoped state, created on first use.
 *
 * The credential store is re-read on every call: `initMachineApiKeyStore` and
 * `initApiKeyStore` can both change which one is current, and holding a
 * torn-down one here would silently drop a stored key down to the
 * environment-variable tier.
 */
function machineScope(): ApiKeyScopeState {
  const state = machineScopeState ?? createMachineScopeState();
  machineScopeState = state;
  // The machine store wins when one is registered. Falling back to the
  // project's keeps a test (or a host that never registered one) working, and
  // keeps the two scopes sharing one secret per provider.
  state.credentialStore = machineCredentialStore ?? projectScope.credentialStore;
  return state;
}

/**
 * Register the credential store machine-scoped keys are read from and written
 * to. Call once at app start, before any window can reach the machine-key IPC.
 */
export function initMachineApiKeyStore(options: InitMachineApiKeyStoreOptions): void {
  machineCredentialStore = options.credentialStore ?? null;
  machineScopeState = null;
}

/**
 * Both scopes can read one credential store, so a write through either must not
 * leave the other holding a cached "no key for this provider". Called before
 * the mutation — nothing can observe the gap, since the store is synchronous.
 */
function invalidatePeerScopeCache(scope: ApiKeyScopeState): void {
  if (scope === machineScopeState) {
    projectScope.cache = null;
    projectScope.missingCredentialProviders = new Set<string>();
    return;
  }
  machineScopeState = null;
}

export function storeMachineApiKey(provider: string, key: string): void {
  storeApiKeyIn(machineScope(), provider, key, { deviceOnly: true });
}

export function getMachineApiKey(provider: string): string | null {
  return getApiKeyIn(machineScope(), provider);
}

export function deleteMachineApiKey(provider: string): void {
  deleteApiKeyIn(machineScope(), provider);
}

export function listMachineStoredProviders(): string[] {
  return listStoredProvidersIn(machineScope());
}

/**
 * What the UI needs to render without ever seeing the secret: whether a key
 * resolves, and whether it is one ADE can replace (`store`) or one the machine's
 * environment owns (`env`, read-only here).
 */
export function getMachineApiKeyStatus(provider: string): MachineApiKeyStatus {
  const normalizedProvider = normalizeProvider(provider);
  const envVar = ENV_KEY_PROVIDERS[normalizedProvider] ?? null;
  if (!normalizedProvider.length) {
    return { provider: normalizedProvider, configured: false, source: null, envVar };
  }
  const scope = machineScope();
  let resolved: string | null = null;
  try {
    resolved = getApiKeyIn(scope, normalizedProvider);
  } catch {
    // An unreadable store is "no key", not a crash in a settings render.
    return { provider: normalizedProvider, configured: false, source: null, envVar };
  }
  if (!resolved) {
    return { provider: normalizedProvider, configured: false, source: null, envVar };
  }
  // `getApiKeyIn` promotes a credential-store or Keychain hit into the in-memory
  // map before returning it; only an env-var hit is absent from it.
  const fromStore = Boolean(ensureStore(scope)[normalizedProvider]?.trim());
  const source: MachineApiKeySource = fromStore ? "store" : "env";
  return { provider: normalizedProvider, configured: true, source, envVar };
}

function getApiKeyStoreStatusIn(scope: ApiKeyScopeState): ApiKeyStoreStatus {
  if (!scope.storePath || !scope.legacyStorePath) {
    return {
      secureStorageAvailable: isPersistentSecureStorageAvailable(scope),
      macosKeychainAvailable: isMacosKeychainAvailable(),
      macosKeychainService: isMacosKeychainAvailable() ? MACOS_KEYCHAIN_SERVICE : null,
      macosKeychainError: scope.macosKeychainError,
      encryptedStorePath: null,
      legacyPlaintextDetected: false,
      legacyPlaintextPath: null,
      decryptionFailed: scope.decryptionFailed,
    };
  }
  return {
    secureStorageAvailable: isPersistentSecureStorageAvailable(scope),
    macosKeychainAvailable: isMacosKeychainAvailable(),
    macosKeychainService: isMacosKeychainAvailable() ? MACOS_KEYCHAIN_SERVICE : null,
    macosKeychainError: scope.macosKeychainError,
    encryptedStorePath: scope.credentialStore ? null : scope.storePath,
    legacyPlaintextDetected: Boolean(scope.legacyStorePath && fs.existsSync(scope.legacyStorePath)),
    legacyPlaintextPath: scope.legacyStorePath && fs.existsSync(scope.legacyStorePath) ? scope.legacyStorePath : null,
    decryptionFailed: scope.decryptionFailed,
  };
}

export function getApiKeyStoreStatus(): ApiKeyStoreStatus {
  return getApiKeyStoreStatusIn(projectScope);
}

function storeApiKeyIn(
  scope: ApiKeyScopeState,
  provider: string,
  key: string,
  options: { deviceOnly?: boolean } = {},
): void {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedKey = key.trim();
  if (!normalizedProvider.length || !normalizedKey.length) {
    throw new Error("Provider and key are required.");
  }
  invalidatePeerScopeCache(scope);
  const store = ensureStore(scope);
  if (scope.credentialStore) {
    writeCredentialSecret(scope, credentialProviderKey(normalizedProvider), normalizedKey);
    store[normalizedProvider] = normalizedKey;
    scope.missingCredentialProviders.delete(normalizedProvider);
    const index = readCredentialProviderIndex(scope);
    writeCredentialProviderIndex(scope, new Set([...index.providers, normalizedProvider]));
    noteStoreWriteCommitted(scope);
    if (normalizedProvider === "cursor") cursorKeyOrigin = "pasted";
    if (!options.deviceOnly) {
      fireAndForgetVaultCall(
        "set",
        normalizedProvider,
        (vault) => vault.set("all", "provider_api_key", normalizedProvider, normalizedKey),
      );
    }
    return;
  }
  const nextStore = { ...store, [normalizedProvider]: normalizedKey };
  persistEncryptedStore(scope, nextStore);
  deleteMacosKeychainSecretBestEffort(scope, normalizedProvider);
  scope.missingMacosKeychainProviders.add(normalizedProvider);
  scope.cache = nextStore;
  noteStoreWriteCommitted(scope);
  if (normalizedProvider === "cursor") cursorKeyOrigin = "pasted";
  if (!options.deviceOnly) {
    fireAndForgetVaultCall(
      "set",
      normalizedProvider,
      (vault) => vault.set("all", "provider_api_key", normalizedProvider, normalizedKey),
    );
  }
}

export function storeApiKey(
  provider: string,
  key: string,
  options: { deviceOnly?: boolean } = {},
): void {
  storeApiKeyIn(projectScope, provider, key, options);
}

function getApiKeyIn(scope: ApiKeyScopeState, provider: string): string | null {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider.length) return null;
  const store = ensureStore(scope);
  const stored = store[normalizedProvider];
  if (stored) return stored;
  if (scope.credentialStore && !scope.missingCredentialProviders.has(normalizedProvider)) {
    const credentialValue = readCredentialSecret(scope, credentialProviderKey(normalizedProvider));
    if (credentialValue) {
      store[normalizedProvider] = credentialValue;
      const index = readCredentialProviderIndex(scope);
      writeCredentialProviderIndex(scope, new Set([...index.providers, normalizedProvider]));
      return credentialValue;
    }
    scope.missingCredentialProviders.add(normalizedProvider);
  }
  const allowLegacyKeychainFallback =
    !scope.credentialStore || !isCredentialLegacyKeychainMigrated(scope);
  if (allowLegacyKeychainFallback && isMacosKeychainAvailable() && !scope.missingMacosKeychainProviders.has(normalizedProvider)) {
    const keychainValue = readMacosKeychainSecret(scope, normalizedProvider);
    if (keychainValue) {
      store[normalizedProvider] = keychainValue;
      if (scope.credentialStore) {
        writeCredentialSecret(scope, credentialProviderKey(normalizedProvider), keychainValue);
        const index = readCredentialProviderIndex(scope);
        writeCredentialProviderIndex(scope, new Set([...index.providers, normalizedProvider]));
      } else if (canPersistEncryptedStore(scope)) {
        persistEncryptedStore(scope, store);
      }
      return keychainValue;
    }
    scope.missingMacosKeychainProviders.add(normalizedProvider);
  }
  const envVar = ENV_KEY_PROVIDERS[normalizedProvider];
  if (envVar) {
    const envValue = (process.env[envVar] ?? "").trim();
    if (envValue.length > 0) return envValue;
  }
  return null;
}

export function getApiKey(provider: string): string | null {
  return getApiKeyIn(projectScope, provider);
}

function deleteApiKeyIn(scope: ApiKeyScopeState, provider: string): void {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider.length) return;
  invalidatePeerScopeCache(scope);
  const store = ensureStore(scope);
  if (normalizedProvider === "cursor") cursorKeyOrigin = null;
  if (scope.credentialStore) {
    deleteCredentialSecret(scope, credentialProviderKey(normalizedProvider));
    delete store[normalizedProvider];
    scope.missingCredentialProviders.add(normalizedProvider);
    const index = readCredentialProviderIndex(scope);
    writeCredentialProviderIndex(scope, index.providers.filter((entry) => entry !== normalizedProvider));
    noteStoreWriteCommitted(scope);
    if (scope === projectScope) {
      fireAndForgetVaultCall(
        "remove",
        normalizedProvider,
        (vault) => vault.remove("all", "provider_api_key", normalizedProvider),
      );
    }
    return;
  }
  const nextStore = { ...store };
  delete nextStore[normalizedProvider];
  if (canPersistEncryptedStore(scope)) {
    persistEncryptedStore(scope, nextStore);
  }
  deleteMacosKeychainSecretBestEffort(scope, normalizedProvider);
  scope.missingMacosKeychainProviders.add(normalizedProvider);
  scope.cache = nextStore;
  noteStoreWriteCommitted(scope);
  if (scope === projectScope) {
    fireAndForgetVaultCall(
      "remove",
      normalizedProvider,
      (vault) => vault.remove("all", "provider_api_key", normalizedProvider),
    );
  }
}

export function deleteApiKey(provider: string): void {
  deleteApiKeyIn(projectScope, provider);
}

function listStoredProvidersIn(scope: ApiKeyScopeState): string[] {
  return Object.keys(ensureStore(scope));
}

export function listStoredProviders(): string[] {
  return listStoredProvidersIn(projectScope);
}

/**
 * Copy account-scoped provider keys into the local store without replacing a
 * value this machine already has. The vault list intentionally omits secret
 * values, so readable rows are fetched individually before they are stored.
 */
export async function hydrateApiKeysFromVault(): Promise<void> {
  const vault = resolveAccountVault("list", "*");
  if (!vault) return;

  let listed: Awaited<ReturnType<AccountVaultBridge["list"]>>;
  try {
    listed = await vault.list("all");
  } catch (error) {
    logVaultFailure("list", "*", error);
    return;
  }
  if (!listed.ok) {
    logVaultFailure("list", "*", listed);
    return;
  }

  for (const item of listed.value) {
    if (item.scope !== "all" || item.kind !== "provider_api_key") continue;
    const provider = normalizeProvider(item.key);
    if (!provider.length) continue;

    let value = typeof item.value === "string" ? item.value.trim() : "";
    if (!value.length) {
      let fetched: Awaited<ReturnType<AccountVaultBridge["get"]>>;
      try {
        fetched = await vault.get("all", "provider_api_key", provider);
      } catch (error) {
        logVaultFailure("get", provider, error);
        continue;
      }
      if (!fetched.ok) {
        logVaultFailure("get", provider, fetched);
        continue;
      }
      value = fetched.value?.trim() ?? "";
    }
    if (!value.length) continue;

    try {
      if (getApiKey(provider)) continue;
      storeApiKey(provider, value, { deviceOnly: true });
    } catch (error) {
      logVaultFailure("hydrate", provider, error);
    }
  }
}

/**
 * Mark the current ADE-stored Cursor key as minted by Cursor.auth.login().
 * Call after storeApiKey("cursor", mintedKey) — storeApiKey itself records a
 * paste so a later Sign out can keep a key the user typed in afterwards.
 */
export function markCursorApiKeyOAuthMinted(): void {
  try {
    const stored = ensureStore(projectScope).cursor?.trim();
    cursorKeyOrigin = stored ? "oauth" : null;
  } catch {
    cursorKeyOrigin = null;
  }
}

/** Origin of the ADE-stored Cursor key, or null when none is stored. */
export function getCursorApiKeyOrigin(): "oauth" | "pasted" | null {
  try {
    const stored = ensureStore(projectScope).cursor?.trim();
    if (!stored) return null;
    return cursorKeyOrigin;
  } catch {
    return null;
  }
}

export function getAllApiKeys(): Record<string, string> {
  return { ...ensureStore(projectScope) };
}
