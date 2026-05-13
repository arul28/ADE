import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { SafeStorage } from "electron";
import { resolveAdeLayout } from "../../../shared/adeLayout";

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

export type ApiKeyCredentialStore = {
  get?: (key: string) => Promise<string | null> | string | null;
  set?: (key: string, value: string) => Promise<void> | void;
  delete?: (key: string) => Promise<void> | void;
  getSync?: (key: string) => string | null;
  setSync?: (key: string, value: string) => void;
  deleteSync?: (key: string) => void;
};

export type InitApiKeyStoreOptions = {
  credentialStore?: ApiKeyCredentialStore | null;
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

let storePath: string | null = null;
let legacyStorePath: string | null = null;
let projectRootPath: string | null = null;
let credentialStore: ApiKeyCredentialStore | null = null;
let cache: StoredKeys | null = null;
let decryptionFailed = false;
let macosKeychainError: string | null = null;
let missingMacosKeychainProviders = new Set<string>();
let missingCredentialProviders = new Set<string>();

export function __setSafeStorageForTests(next: SafeStorage | null): void {
  safeStorage = next;
  cache = null;
  missingMacosKeychainProviders = new Set<string>();
}

function isSecureStorageAvailable(): boolean {
  return Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === "function" && safeStorage.isEncryptionAvailable());
}

function isMacosKeychainAvailable(): boolean {
  if (process.env.ADE_API_KEY_STORE_DISABLE_KEYCHAIN === "1") return false;
  if (process.env.NODE_ENV === "test" && process.env.ADE_API_KEY_STORE_FORCE_KEYCHAIN === "1") return true;
  return process.platform === "darwin" && fs.existsSync(MACOS_SECURITY_BIN);
}

function isPersistentSecureStorageAvailable(): boolean {
  if (credentialStore) return true;
  return isMacosKeychainAvailable() || isSecureStorageAvailable();
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

function ensureInitialized(): void {
  if (!storePath || !legacyStorePath) {
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

function rememberKeychainError(action: string, result: SecurityResult): void {
  const detail = result.stderr.trim().split(/\r?\n/)[0] || `status ${result.status ?? "unknown"}`;
  macosKeychainError = `macOS Keychain ${action} failed: ${detail}`;
}

function clearKeychainError(): void {
  macosKeychainError = null;
}

function trimTrailingNewline(value: string): string {
  return value.replace(/(?:\r?\n)+$/, "");
}

function readMacosKeychainSecret(account: string): string | null {
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
    clearKeychainError();
    const value = trimTrailingNewline(result.stdout).trim();
    return value.length ? value : null;
  }
  if (!securityMissing(result)) {
    rememberKeychainError("read", result);
  }
  return null;
}

function writeMacosKeychainSecret(account: string, value: string): void {
  if (!isMacosKeychainAvailable()) {
    throw new Error("macOS Keychain is unavailable. Cannot persist API keys.");
  }
  // `/usr/bin/security add-generic-password` does not support a non-interactive
  // stdin password sentinel: `-w -` stores a literal dash. Keep this path
  // synchronous and tightly scoped until we replace it with a native binding.
  const result = runSecurity([
    "add-generic-password",
    "-a",
    account,
    "-s",
    MACOS_KEYCHAIN_SERVICE,
    "-w",
    value,
    "-U",
  ]);
  if (!result.ok) {
    rememberKeychainError("write", result);
    throw new Error(macosKeychainError ?? "macOS Keychain write failed.");
  }
  clearKeychainError();
}

function deleteMacosKeychainSecret(account: string): void {
  if (!isMacosKeychainAvailable()) return;
  const result = runSecurity([
    "delete-generic-password",
    "-a",
    account,
    "-s",
    MACOS_KEYCHAIN_SERVICE,
  ]);
  if (result.ok || securityMissing(result)) {
    clearKeychainError();
    return;
  }
  rememberKeychainError("delete", result);
  throw new Error(macosKeychainError ?? "macOS Keychain delete failed.");
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

function getSyncCredentialStore(): Required<Pick<ApiKeyCredentialStore, "getSync" | "setSync" | "deleteSync">> | null {
  if (!credentialStore) return null;
  if (
    typeof credentialStore.getSync === "function"
    && typeof credentialStore.setSync === "function"
    && typeof credentialStore.deleteSync === "function"
  ) {
    return credentialStore as Required<Pick<ApiKeyCredentialStore, "getSync" | "setSync" | "deleteSync">>;
  }
  throw new Error("API key credentialStore must provide getSync, setSync, and deleteSync.");
}

function readCredentialSecret(key: string): string | null {
  const store = getSyncCredentialStore();
  if (!store) return null;
  try {
    const value = store.getSync(key);
    decryptionFailed = false;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  } catch {
    decryptionFailed = true;
    return null;
  }
}

function writeCredentialSecret(key: string, value: string): void {
  const store = getSyncCredentialStore();
  if (!store) return;
  store.setSync(key, value);
  decryptionFailed = false;
}

function deleteCredentialSecret(key: string): void {
  const store = getSyncCredentialStore();
  if (!store) return;
  store.deleteSync(key);
  decryptionFailed = false;
}

function readCredentialProviderIndex(): { exists: boolean; providers: string[] } {
  const raw = readCredentialSecret(CREDENTIAL_PROVIDER_INDEX_KEY);
  if (!raw) return { exists: false, providers: [] };
  try {
    return { exists: true, providers: normalizeProviderList(JSON.parse(raw)) };
  } catch {
    decryptionFailed = true;
    return { exists: true, providers: [] };
  }
}

function writeCredentialProviderIndex(providers: Iterable<string>): void {
  writeCredentialSecret(CREDENTIAL_PROVIDER_INDEX_KEY, JSON.stringify(normalizeProviderList(Array.from(providers))));
}

function readCredentialLegacyMigratedProjectRoots(): Set<string> {
  const raw = readCredentialSecret(CREDENTIAL_LEGACY_PROJECTS_MIGRATED_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    const roots = parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => path.resolve(entry));
    return new Set(roots);
  } catch {
    decryptionFailed = true;
    return new Set();
  }
}

function writeCredentialLegacyMigratedProjectRoots(projectRoots: Iterable<string>): void {
  const normalized = Array.from(new Set(Array.from(projectRoots).map((entry) => path.resolve(entry)))).sort();
  writeCredentialSecret(CREDENTIAL_LEGACY_PROJECTS_MIGRATED_KEY, JSON.stringify(normalized));
}

function isCredentialLegacyKeychainMigrated(): boolean {
  return Boolean(readCredentialSecret(CREDENTIAL_LEGACY_KEYCHAIN_MIGRATED_KEY));
}

function markCredentialLegacyKeychainMigrated(): void {
  writeCredentialSecret(CREDENTIAL_LEGACY_KEYCHAIN_MIGRATED_KEY, new Date().toISOString());
}

function readCredentialStore(providerCandidates: Iterable<string>): StoredKeys {
  const out: StoredKeys = {};
  for (const provider of providerCandidates) {
    const normalizedProvider = normalizeProvider(provider);
    if (!normalizedProvider.length) continue;
    const value = readCredentialSecret(credentialProviderKey(normalizedProvider));
    if (value) out[normalizedProvider] = value;
  }
  return out;
}

function mergeLegacyValuesIntoCredentialStore(
  currentStore: StoredKeys,
  legacyStore: StoredKeys,
): StoredKeys {
  const nextStore = { ...currentStore };
  const changedProviders = new Set<string>();
  for (const [provider, rawValue] of Object.entries(legacyStore)) {
    const normalizedProvider = normalizeProvider(provider);
    const value = rawValue.trim();
    if (!normalizedProvider.length || !value.length || nextStore[normalizedProvider]) continue;
    writeCredentialSecret(credentialProviderKey(normalizedProvider), value);
    nextStore[normalizedProvider] = value;
    changedProviders.add(normalizedProvider);
  }
  if (changedProviders.size) {
    const index = readCredentialProviderIndex();
    writeCredentialProviderIndex(new Set([...index.providers, ...Object.keys(nextStore)]));
  }
  return nextStore;
}

function migrateLegacyProjectStoreIntoCredentialStore(currentStore: StoredKeys): StoredKeys {
  if (!projectRootPath) return currentStore;
  const migratedProjectRoots = readCredentialLegacyMigratedProjectRoots();
  const normalizedProjectRoot = path.resolve(projectRootPath);
  if (migratedProjectRoots.has(normalizedProjectRoot)) return currentStore;

  const hadEncryptedStore = Boolean(storePath && fs.existsSync(storePath));
  const legacyStore = loadEncryptedStore();
  const migrationComplete = !hadEncryptedStore || !decryptionFailed;
  const nextStore = mergeLegacyValuesIntoCredentialStore(currentStore, legacyStore);

  if (migrationComplete) {
    migratedProjectRoots.add(normalizedProjectRoot);
    writeCredentialLegacyMigratedProjectRoots(migratedProjectRoots);
  }
  return nextStore;
}

function migrateLegacyKeychainIntoCredentialStore(currentStore: StoredKeys): StoredKeys {
  if (isCredentialLegacyKeychainMigrated()) return currentStore;
  if (!isMacosKeychainAvailable()) return currentStore;

  const index = readMacosKeychainProviderIndex();
  const providerCandidates = new Set([
    ...index.providers,
    ...Object.keys(ENV_KEY_PROVIDERS),
  ]);
  const keychainStore = readMacosKeychainStore(providerCandidates);
  const nextStore = mergeLegacyValuesIntoCredentialStore(currentStore, keychainStore);
  markCredentialLegacyKeychainMigrated();
  return nextStore;
}

function migrateLegacyStoresIntoCredentialStore(currentStore: StoredKeys): StoredKeys {
  let nextStore = currentStore;
  try {
    nextStore = migrateLegacyKeychainIntoCredentialStore(nextStore);
  } catch {
    // Keep the machine credential store usable even if a legacy Keychain read
    // or write is blocked. The legacy copy remains available for a later retry.
  }
  try {
    nextStore = migrateLegacyProjectStoreIntoCredentialStore(nextStore);
  } catch {
    // Best effort. A failed migration must not block app or runtime startup.
  }
  return nextStore;
}

function readMacosKeychainProviderIndex(): { exists: boolean; providers: string[] } {
  const raw = readMacosKeychainSecret(MACOS_KEYCHAIN_PROVIDER_INDEX_ACCOUNT);
  if (!raw) return { exists: false, providers: [] };
  try {
    return { exists: true, providers: normalizeProviderList(JSON.parse(raw)) };
  } catch {
    macosKeychainError = "macOS Keychain provider index is unreadable.";
    return { exists: true, providers: [] };
  }
}

function writeMacosKeychainProviderIndex(providers: Iterable<string>): void {
  writeMacosKeychainSecret(
    MACOS_KEYCHAIN_PROVIDER_INDEX_ACCOUNT,
    JSON.stringify(normalizeProviderList(Array.from(providers))),
  );
}

function tryWriteMacosKeychainProviderIndex(providers: Iterable<string>): void {
  try {
    writeMacosKeychainProviderIndex(providers);
  } catch {
    // The provider index only powers discovery/listing. Keep the just-written
    // secret usable in this process even if the secondary index write fails.
  }
}

function readMacosKeychainStore(providerCandidates: Iterable<string>): StoredKeys {
  const out: StoredKeys = {};
  if (!isMacosKeychainAvailable()) return out;
  for (const provider of providerCandidates) {
    if (provider === MACOS_KEYCHAIN_PROVIDER_INDEX_ACCOUNT) continue;
    const value = readMacosKeychainSecret(provider);
    if (value) out[provider] = value;
  }
  return out;
}

function loadEncryptedStore(): StoredKeys {
  ensureInitialized();

  if (!storePath || !legacyStorePath) {
    return {};
  }

  if (!fs.existsSync(storePath)) {
    decryptionFailed = false;
    return {};
  }

  if (!isSecureStorageAvailable()) {
    decryptionFailed = true;
    return {};
  }

  try {
    const raw = fs.readFileSync(storePath);
    const decrypted = safeStorage!.decryptString(raw);
    decryptionFailed = false;
    return normalizeStoredKeys(JSON.parse(decrypted));
  } catch {
    decryptionFailed = true;
    return {};
  }
}

function migrateEncryptedStoreToMacosKeychain(encryptedStore: StoredKeys): void {
  if (!isMacosKeychainAvailable()) return;
  const providers = Object.keys(encryptedStore);
  if (!providers.length) return;

  const existingIndex = readMacosKeychainProviderIndex();
  const nextProviders = new Set<string>(existingIndex.providers);
  let changed = false;

  for (const provider of providers) {
    const value = encryptedStore[provider]?.trim();
    if (!value) continue;
    const existingValue = readMacosKeychainSecret(provider);
    if (!existingValue) {
      writeMacosKeychainSecret(provider, value);
    }
    nextProviders.add(provider);
    changed = true;
  }

  if (changed) {
    writeMacosKeychainProviderIndex(nextProviders);
  }
}

function ensureStore(): StoredKeys {
  if (cache) return cache;
  ensureInitialized();

  if (credentialStore) {
    const index = readCredentialProviderIndex();
    const credentialValues = index.exists ? readCredentialStore(index.providers) : {};
    cache = migrateLegacyStoresIntoCredentialStore(credentialValues);
    return cache;
  }

  const encryptedStore = loadEncryptedStore();
  if (isMacosKeychainAvailable()) {
    const indexBeforeMigration = readMacosKeychainProviderIndex();
    if (!indexBeforeMigration.exists) {
      try {
        migrateEncryptedStoreToMacosKeychain(encryptedStore);
      } catch {
        // If Keychain migration is blocked, keep the decryptable encrypted
        // store as the active fallback instead of dropping existing keys.
      }
    }

    const index = readMacosKeychainProviderIndex();
    if (index.exists) {
      cache = readMacosKeychainStore(index.providers);
      return cache;
    }

    // Without an index, avoid probing every known provider synchronously on the
    // Electron main thread. The old encrypted store remains the migration
    // source of truth; direct Keychain reads happen on-demand by provider.
    cache = encryptedStore;
    return cache;
  }

  cache = encryptedStore;
  return cache;
}

function persistEncryptedStore(nextStore: StoredKeys = cache ?? {}): void {
  if (!storePath) return;
  if (!isSecureStorageAvailable()) {
    throw new Error("OS secure storage is unavailable. Cannot persist API keys.");
  }
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const encrypted = safeStorage!.encryptString(JSON.stringify(nextStore));
  fs.writeFileSync(storePath, encrypted);
  try {
    fs.chmodSync(storePath, 0o600);
  } catch {
    // Best effort
  }
}

export function initApiKeyStore(projectRoot: string, options: InitApiKeyStoreOptions = {}): void {
  const layout = resolveAdeLayout(projectRoot);
  projectRootPath = path.resolve(projectRoot);
  storePath = layout.apiKeysPath;
  legacyStorePath = layout.legacyApiKeysPath;
  credentialStore = options.credentialStore ?? null;
  cache = null;
  decryptionFailed = false;
  macosKeychainError = null;
  missingMacosKeychainProviders = new Set<string>();
  missingCredentialProviders = new Set<string>();
}

export function getApiKeyStoreStatus(): ApiKeyStoreStatus {
  if (!storePath || !legacyStorePath) {
    return {
      secureStorageAvailable: isPersistentSecureStorageAvailable(),
      macosKeychainAvailable: isMacosKeychainAvailable(),
      macosKeychainService: isMacosKeychainAvailable() ? MACOS_KEYCHAIN_SERVICE : null,
      macosKeychainError,
      encryptedStorePath: null,
      legacyPlaintextDetected: false,
      legacyPlaintextPath: null,
      decryptionFailed,
    };
  }
  return {
    secureStorageAvailable: isPersistentSecureStorageAvailable(),
    macosKeychainAvailable: isMacosKeychainAvailable(),
    macosKeychainService: isMacosKeychainAvailable() ? MACOS_KEYCHAIN_SERVICE : null,
    macosKeychainError,
    encryptedStorePath: credentialStore ? null : storePath,
    legacyPlaintextDetected: Boolean(legacyStorePath && fs.existsSync(legacyStorePath)),
    legacyPlaintextPath: legacyStorePath && fs.existsSync(legacyStorePath) ? legacyStorePath : null,
    decryptionFailed,
  };
}

export function storeApiKey(provider: string, key: string): void {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedKey = key.trim();
  if (!normalizedProvider.length || !normalizedKey.length) {
    throw new Error("Provider and key are required.");
  }
  const store = ensureStore();
  if (credentialStore) {
    writeCredentialSecret(credentialProviderKey(normalizedProvider), normalizedKey);
    store[normalizedProvider] = normalizedKey;
    missingCredentialProviders.delete(normalizedProvider);
    const index = readCredentialProviderIndex();
    writeCredentialProviderIndex(new Set([...index.providers, normalizedProvider]));
    return;
  }
  if (isMacosKeychainAvailable()) {
    writeMacosKeychainSecret(normalizedProvider, normalizedKey);
    store[normalizedProvider] = normalizedKey;
    missingMacosKeychainProviders.delete(normalizedProvider);
    const index = readMacosKeychainProviderIndex();
    tryWriteMacosKeychainProviderIndex(new Set([...index.providers, normalizedProvider]));
    return;
  }
  const nextStore = { ...store, [normalizedProvider]: normalizedKey };
  persistEncryptedStore(nextStore);
  cache = nextStore;
}

export function getApiKey(provider: string): string | null {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider.length) return null;
  const store = ensureStore();
  const stored = store[normalizedProvider];
  if (stored) return stored;
  if (credentialStore && !missingCredentialProviders.has(normalizedProvider)) {
    const credentialValue = readCredentialSecret(credentialProviderKey(normalizedProvider));
    if (credentialValue) {
      store[normalizedProvider] = credentialValue;
      const index = readCredentialProviderIndex();
      writeCredentialProviderIndex(new Set([...index.providers, normalizedProvider]));
      return credentialValue;
    }
    missingCredentialProviders.add(normalizedProvider);
  }
  const allowLegacyKeychainFallback =
    !credentialStore || !isCredentialLegacyKeychainMigrated();
  if (allowLegacyKeychainFallback && isMacosKeychainAvailable() && !missingMacosKeychainProviders.has(normalizedProvider)) {
    const keychainValue = readMacosKeychainSecret(normalizedProvider);
    if (keychainValue) {
      store[normalizedProvider] = keychainValue;
      const index = readMacosKeychainProviderIndex();
      tryWriteMacosKeychainProviderIndex(new Set([...index.providers, normalizedProvider]));
      return keychainValue;
    }
    missingMacosKeychainProviders.add(normalizedProvider);
  }
  const envVar = ENV_KEY_PROVIDERS[normalizedProvider];
  if (envVar) {
    const envValue = (process.env[envVar] ?? "").trim();
    if (envValue.length > 0) return envValue;
  }
  return null;
}

export function deleteApiKey(provider: string): void {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider.length) return;
  const store = ensureStore();
  if (credentialStore) {
    deleteCredentialSecret(credentialProviderKey(normalizedProvider));
    delete store[normalizedProvider];
    missingCredentialProviders.add(normalizedProvider);
    const index = readCredentialProviderIndex();
    writeCredentialProviderIndex(index.providers.filter((entry) => entry !== normalizedProvider));
    return;
  }
  if (isMacosKeychainAvailable()) {
    deleteMacosKeychainSecret(normalizedProvider);
    delete store[normalizedProvider];
    missingMacosKeychainProviders.add(normalizedProvider);
    const index = readMacosKeychainProviderIndex();
    tryWriteMacosKeychainProviderIndex(index.providers.filter((entry) => entry !== normalizedProvider));
    return;
  }
  const nextStore = { ...store };
  delete nextStore[normalizedProvider];
  persistEncryptedStore(nextStore);
  cache = nextStore;
}

export function listStoredProviders(): string[] {
  const store = ensureStore();
  return Object.keys(store);
}

export function getAllApiKeys(): Record<string, string> {
  return { ...ensureStore() };
}
