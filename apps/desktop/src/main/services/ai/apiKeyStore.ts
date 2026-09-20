import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { SafeStorage } from "electron";
import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { isSafeIdentifier } from "../../../shared/safeIdentifier";
import {
  deviceCredentialProvenance,
  normalizeCredentialProvenance,
  type CredentialProvenance,
} from "../../../shared/types/credentialProvenance";
import type { MachineApiKeySource, MachineApiKeyStatus } from "../../../shared/types/config";
import {
  DEFAULT_API_CREDENTIAL_ID,
  type ApiCredentialStoreArgs,
  type ApiCredentialSummary,
} from "../../../shared/types/apiCredentials";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type { AccountVaultBridge } from "../account/accountVaultBridge";
import {
  describeVaultFailure,
  fireAndForgetVaultWrite,
} from "../account/vaultWrite";
import type { Logger } from "../logging/logger";
import { writeFileAtomic } from "../state/durableFile";
import {
  removeCredentialLaunchHome,
  type PrivateTreeCleanupOptions,
} from "../chat/harnessPresetConfigHomes";
import {
  captureApiCredentialAnalytics,
  type FeatureAnalytics,
} from "../analytics/featureProductAnalytics";


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

type ApiCredentialInternalOptions = {
  source?: "device" | "account";
  accountUserId?: string | null;
};

export type ApiKeyProvenance = CredentialProvenance;

export type ApiKeyCredentialStore = SyncCredentialStore;

export type ApiKeyHydrationCollision = {
  provider: string;
  credentialId: string;
  existingCredentialId: string;
  storageKey: string;
};

export type ApiKeyHydrationResult = {
  collisions: ApiKeyHydrationCollision[];
};

export type InitApiKeyStoreOptions = {
  credentialStore?: ApiKeyCredentialStore | null;
  getAccountVault?: () => AccountVaultBridge | null | undefined;
  getAccountUserId?: () => string | null;
  logger?: Pick<Logger, "warn"> | null;
  /** Test seam; production resolves the machine ADE home. */
  launchHomeAdeDir?: string;
  /** Brain/main-owned product analytics; omitted by isolated store tests. */
  analytics?: FeatureAnalytics | null;
};

export type InitMachineApiKeyStoreOptions = {
  credentialStore: ApiKeyCredentialStore | null;
  /** Test seam; production resolves the machine ADE home. */
  launchHomeAdeDir?: string;
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
const API_CREDENTIALS_INDEX_KEY = "ai.api_credentials.index.v1";
const CREDENTIAL_PROVIDER_PROVENANCE_KEY = "ai.api_key.provenance.v1";
const PROVENANCE_FILE_SUFFIX = ".provenance";
const DEFAULT_CREDENTIAL_ID = DEFAULT_API_CREDENTIAL_ID;
const LEGACY_CREDENTIAL_TIMESTAMP = "1970-01-01T00:00:00.000Z";

let getAccountVault: (() => AccountVaultBridge | null | undefined) | null = null;
let getAccountUserId: (() => string | null) | null = null;
let vaultLogger: Pick<Logger, "warn"> | null = null;
let productAnalytics: FeatureAnalytics | null = null;

function logVaultFailure(operation: string, provider: string, detail: unknown): void {
  vaultLogger?.warn("ai.api_key_vault_sync_failed", {
    operation,
    provider,
    error: describeVaultFailure(detail),
  });
}

const HYDRATION_COLLISION_MESSAGE =
  "credential id collides case-insensitively with an existing local credential; skipped";

function logHydrationCollision(collision: ApiKeyHydrationCollision): void {
  vaultLogger?.warn("ai.api_key_vault_sync_failed", {
    operation: "hydrate",
    provider: collision.storageKey,
    credentialId: collision.credentialId,
    existingCredentialId: collision.existingCredentialId,
    error: HYDRATION_COLLISION_MESSAGE,
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
  launchHomeAdeDir: string | null;
  credentialStore: ApiKeyCredentialStore | null;
  cache: StoredKeys | null;
  summaries: ApiCredentialSummary[] | null;
  provenance: Record<string, ApiKeyProvenance> | null;
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
    launchHomeAdeDir: null,
    credentialStore: null,
    cache: null,
    summaries: null,
    provenance: null,
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
  projectScope.summaries = null;
  projectScope.provenance = null;
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

function normalizeCredentialId(credentialId: string): string {
  const normalized = credentialId.trim();
  if (!normalized || normalized.includes("#") || !isSafeIdentifier(normalized)) return "";
  return normalized;
}

function credentialStorageKey(provider: string, credentialId = DEFAULT_CREDENTIAL_ID): string {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedCredentialId = normalizeCredentialId(credentialId);
  if (!normalizedProvider || !isSafeIdentifier(normalizedProvider) || !normalizedCredentialId) return "";
  return normalizedCredentialId === DEFAULT_CREDENTIAL_ID
    ? normalizedProvider
    : `${normalizedProvider}#${normalizedCredentialId}`;
}

function parseCredentialStorageKey(value: string): { provider: string; credentialId: string } | null {
  const separator = value.indexOf("#");
  const provider = normalizeProvider(separator >= 0 ? value.slice(0, separator) : value);
  const credentialId = separator >= 0
    ? normalizeCredentialId(value.slice(separator + 1))
    : DEFAULT_CREDENTIAL_ID;
  if (!provider || !credentialId) return null;
  return { provider, credentialId };
}

function normalizeCredentialStorageKey(value: string): string {
  const parsed = parseCredentialStorageKey(value);
  return parsed ? credentialStorageKey(parsed.provider, parsed.credentialId) : "";
}

function isDefaultCredentialStorageKey(value: string): boolean {
  return parseCredentialStorageKey(value)?.credentialId === DEFAULT_CREDENTIAL_ID;
}

function isReservedStoreEntry(key: string): boolean {
  return [
    API_CREDENTIALS_INDEX_KEY,
    CREDENTIAL_PROVIDER_INDEX_KEY,
    CREDENTIAL_PROVIDER_PROVENANCE_KEY,
    CREDENTIAL_LEGACY_KEYCHAIN_MIGRATED_KEY,
    CREDENTIAL_LEGACY_PROJECTS_MIGRATED_KEY,
  ].includes(key);
}

function normalizeProvenanceMap(value: unknown): Record<string, ApiKeyProvenance> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, ApiKeyProvenance> = {};
  for (const [credentialKey, raw] of Object.entries(value as Record<string, unknown>)) {
    const normalizedCredentialKey = normalizeCredentialStorageKey(credentialKey);
    const normalized = normalizeCredentialProvenance(raw);
    if (normalizedCredentialKey && normalized) out[normalizedCredentialKey] = normalized;
  }
  return out;
}

function normalizeStoredKeys(value: unknown): StoredKeys {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: StoredKeys = {};
  for (const [credentialKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (isReservedStoreEntry(credentialKey)) continue;
    if (typeof rawValue !== "string") continue;
    const normalizedCredentialKey = normalizeCredentialStorageKey(credentialKey);
    const normalizedKey = rawValue.trim();
    if (!normalizedCredentialKey.length || !normalizedKey.length) continue;
    out[normalizedCredentialKey] = normalizedKey;
  }
  return out;
}

function maskCredentialKey(value: string): string {
  return `••••${value.slice(-4)}`;
}

function normalizeCredentialSummaries(value: unknown): ApiCredentialSummary[] {
  if (!Array.isArray(value)) return [];
  const summaries = new Map<string, ApiCredentialSummary>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    if (typeof record.provider !== "string" || typeof record.credentialId !== "string") continue;
    const provider = normalizeProvider(record.provider);
    const credentialId = normalizeCredentialId(record.credentialId);
    if (!provider || !credentialId) continue;
    const label = typeof record.label === "string" && record.label.trim().length
      ? record.label.trim()
      : provider;
    const source = record.source === "store" || record.source === "env" || record.source === "config"
      ? record.source
      : "store";
    const summary: ApiCredentialSummary = {
      provider,
      credentialId,
      label,
      source,
      createdAt: typeof record.createdAt === "string" && record.createdAt.trim().length
        ? record.createdAt
        : LEGACY_CREDENTIAL_TIMESTAMP,
      updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim().length
        ? record.updatedAt
        : LEGACY_CREDENTIAL_TIMESTAMP,
    };
    if (typeof record.envVar === "string" && record.envVar.trim().length) summary.envVar = record.envVar.trim();
    if (typeof record.baseUrl === "string" && record.baseUrl.trim().length) summary.baseUrl = record.baseUrl.trim();
    if (record.protocol === "openai-compatible" || record.protocol === "openai-responses" || record.protocol === "anthropic") {
      summary.protocol = record.protocol;
    }
    if (Array.isArray(record.models)) {
      const models = Array.from(new Set(
        record.models.filter((model): model is string => typeof model === "string" && model.trim().length > 0)
          .map((model) => model.trim()),
      ));
      if (models.length) summary.models = models;
    }
    if (typeof record.maskedTail === "string" && record.maskedTail.trim().length) {
      summary.maskedTail = record.maskedTail.trim();
    }
    const storageKey = credentialStorageKey(provider, credentialId);
    if (storageKey) summaries.set(storageKey, summary);
  }
  return Array.from(summaries.values());
}

function summaryStorageKey(summary: Pick<ApiCredentialSummary, "provider" | "credentialId">): string {
  return credentialStorageKey(summary.provider, summary.credentialId);
}

function legacyCredentialSummary(provider: string, key?: string): ApiCredentialSummary {
  const normalizedProvider = normalizeProvider(provider);
  const summary: ApiCredentialSummary = {
    provider: normalizedProvider,
    credentialId: DEFAULT_CREDENTIAL_ID,
    label: normalizedProvider,
    source: "store",
    createdAt: LEGACY_CREDENTIAL_TIMESTAMP,
    updatedAt: LEGACY_CREDENTIAL_TIMESTAMP,
  };
  const envVar = ENV_KEY_PROVIDERS[normalizedProvider];
  if (envVar) summary.envVar = envVar;
  if (key) summary.maskedTail = maskCredentialKey(key);
  return summary;
}

function environmentCredentialSummary(provider: string): ApiCredentialSummary | null {
  const normalizedProvider = normalizeProvider(provider);
  const envVar = ENV_KEY_PROVIDERS[normalizedProvider];
  if (!envVar) return null;
  const value = (process.env[envVar] ?? "").trim();
  if (!value) return null;
  return {
    ...legacyCredentialSummary(normalizedProvider, value),
    source: "env",
    envVar,
  };
}

function normalizeCredentialModels(models: string[] | undefined): string[] | undefined {
  if (!models) return undefined;
  const normalized = Array.from(new Set(models
    .filter((model): model is string => typeof model === "string")
    .map((model) => model.trim())
    .filter((model) => model.length > 0)));
  return normalized.length ? normalized : undefined;
}

function normalizeCredentialProtocol(
  protocol: ApiCredentialSummary["protocol"] | undefined,
): ApiCredentialSummary["protocol"] | undefined {
  return protocol === "openai-compatible" || protocol === "openai-responses" || protocol === "anthropic"
    ? protocol
    : undefined;
}

function generateCredentialId(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "credential";
  return `${slug}-${randomBytes(3).toString("hex")}`;
}

function buildCredentialSummary(
  args: ApiCredentialStoreArgs,
  provider: string,
  credentialId: string,
  previous: ApiCredentialSummary | undefined,
  key: string,
): ApiCredentialSummary {
  const label = args.label.trim();
  if (!provider || !label || !key.trim()) throw new Error("Provider, label, and key are required.");
  const summary: ApiCredentialSummary = {
    provider,
    credentialId,
    label,
    source: "store",
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    maskedTail: maskCredentialKey(key),
  };
  const envVar = args.envVar?.trim();
  const baseUrl = args.baseUrl?.trim();
  const protocol = normalizeCredentialProtocol(args.protocol);
  const models = normalizeCredentialModels(args.models);
  if (envVar) summary.envVar = envVar;
  if (baseUrl) summary.baseUrl = baseUrl;
  if (protocol) summary.protocol = protocol;
  if (models) summary.models = models;
  return summary;
}

function upsertCredentialSummary(scope: ApiKeyScopeState, summary: ApiCredentialSummary): void {
  const key = summaryStorageKey(summary);
  scope.summaries = [
    ...(scope.summaries ?? []).filter((entry) => summaryStorageKey(entry) !== key),
    summary,
  ];
}

function ensureLegacyCredentialSummary(scope: ApiKeyScopeState, storageKey: string, key: string): void {
  if ((scope.summaries ?? []).some((summary) => summaryStorageKey(summary) === storageKey)) return;
  const parsed = parseCredentialStorageKey(storageKey);
  if (!parsed) return;
  const summary = parsed.credentialId === DEFAULT_CREDENTIAL_ID
    ? legacyCredentialSummary(parsed.provider, key)
    : {
        provider: parsed.provider,
        credentialId: parsed.credentialId,
        label: parsed.credentialId,
        source: "store" as const,
        createdAt: LEGACY_CREDENTIAL_TIMESTAMP,
        updatedAt: LEGACY_CREDENTIAL_TIMESTAMP,
        maskedTail: maskCredentialKey(key),
      };
  upsertCredentialSummary(scope, summary);
  writeApiCredentialIndex(scope, scope.summaries ?? []);
}

function storedCredentialSummaries(scope: ApiKeyScopeState, provider?: string): ApiCredentialSummary[] {
  const normalizedProvider = provider === undefined ? undefined : normalizeProvider(provider);
  const summaries = [...(scope.summaries ?? [])];
  const knownKeys = new Set(summaries.map(summaryStorageKey));
  for (const candidate of Object.keys(ENV_KEY_PROVIDERS)) {
    const summary = environmentCredentialSummary(candidate);
    const key = summary ? summaryStorageKey(summary) : "";
    if (summary && !knownKeys.has(key)) {
      summaries.push(summary);
      knownKeys.add(key);
    }
  }
  return summaries
    .filter((summary) => normalizedProvider === undefined || summary.provider === normalizedProvider)
    .sort((left, right) => {
      const providerOrder = left.provider.localeCompare(right.provider);
      return providerOrder || left.credentialId.localeCompare(right.credentialId);
    });
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

function credentialProviderKey(providerOrCredentialKey: string, credentialId?: string): string {
  const credentialKey = credentialId === undefined
    ? normalizeCredentialStorageKey(providerOrCredentialKey)
    : credentialStorageKey(providerOrCredentialKey, credentialId);
  return `ai.api_key.${credentialKey}.v1`;
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

function provenancePath(scope: ApiKeyScopeState): string | null {
  return scope.storePath
    ? path.join(path.dirname(scope.storePath), `${path.basename(scope.storePath)}${PROVENANCE_FILE_SUFFIX}`)
    : null;
}

function loadEncryptedProvenance(scope: ApiKeyScopeState): Record<string, ApiKeyProvenance> {
  const target = provenancePath(scope);
  if (!target || !fs.existsSync(target) || !isSecureStorageAvailable()) return {};
  try {
    const decrypted = safeStorage!.decryptString(fs.readFileSync(target));
    return normalizeProvenanceMap(JSON.parse(decrypted));
  } catch {
    return {};
  }
}

function readCredentialProvenance(scope: ApiKeyScopeState): Record<string, ApiKeyProvenance> {
  const raw = readCredentialSecret(scope, CREDENTIAL_PROVIDER_PROVENANCE_KEY);
  if (!raw) return {};
  try {
    return normalizeProvenanceMap(JSON.parse(raw));
  } catch {
    return {};
  }
}

function persistProvenance(
  scope: ApiKeyScopeState,
  next: Record<string, ApiKeyProvenance> = scope.provenance ?? {},
): void {
  if (scope.credentialStore) {
    writeCredentialSecret(scope, CREDENTIAL_PROVIDER_PROVENANCE_KEY, JSON.stringify(next));
    noteStoreWriteCommitted(scope);
    return;
  }
  const target = provenancePath(scope);
  if (!target || !isSecureStorageAvailable()) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomic(target, safeStorage!.encryptString(JSON.stringify(next)), { mode: 0o600 });
  noteStoreWriteCommitted(scope);
}

function ensureProvenance(scope: ApiKeyScopeState, credentialKeys: Iterable<string>): Record<string, ApiKeyProvenance> {
  if (!scope.provenance) {
    scope.provenance = scope.credentialStore
      ? readCredentialProvenance(scope)
      : loadEncryptedProvenance(scope);
  }
  let changed = false;
  for (const credentialKey of credentialKeys) {
    const normalizedCredentialKey = normalizeCredentialStorageKey(credentialKey);
    if (normalizedCredentialKey && !scope.provenance[normalizedCredentialKey]) {
      // Existing stores predate provenance. Treat their values as device-only
      // so a later account cannot inherit account ownership; the value remains
      // eligible for this machine's one-time device migration.
      scope.provenance[normalizedCredentialKey] = deviceCredentialProvenance();
      changed = true;
    }
  }
  if (changed) persistProvenance(scope);
  return scope.provenance;
}

function setProvenance(scope: ApiKeyScopeState, credentialKey: string, value: ApiKeyProvenance): void {
  const normalizedCredentialKey = normalizeCredentialStorageKey(credentialKey);
  if (!normalizedCredentialKey) return;
  ensureProvenance(scope, [])[normalizedCredentialKey] = value;
  persistProvenance(scope);
}

function deleteProvenance(scope: ApiKeyScopeState, credentialKey: string): void {
  const normalizedCredentialKey = normalizeCredentialStorageKey(credentialKey);
  if (!scope.provenance) return;
  if (!(normalizedCredentialKey in scope.provenance)) return;
  delete scope.provenance[normalizedCredentialKey];
  persistProvenance(scope);
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
  const defaultProviders = Array.from(new Set(Array.from(providers)
    .map((credentialKey) => parseCredentialStorageKey(credentialKey))
    .filter((parsed): parsed is { provider: string; credentialId: string } => Boolean(parsed))
    .filter((parsed) => parsed.credentialId === DEFAULT_CREDENTIAL_ID)
    .map((parsed) => parsed.provider)));
  writeCredentialSecret(
    scope,
    CREDENTIAL_PROVIDER_INDEX_KEY,
    JSON.stringify(normalizeProviderList(defaultProviders)),
  );
}

function readApiCredentialIndex(scope: ApiKeyScopeState): { exists: boolean; summaries: ApiCredentialSummary[] } {
  if (!scope.credentialStore) {
    return { exists: scope.summaries !== null, summaries: scope.summaries ?? [] };
  }
  const raw = readCredentialSecret(scope, API_CREDENTIALS_INDEX_KEY);
  if (!raw) return { exists: false, summaries: [] };
  try {
    return { exists: true, summaries: normalizeCredentialSummaries(JSON.parse(raw)) };
  } catch {
    return { exists: true, summaries: [] };
  }
}

function writeApiCredentialIndex(scope: ApiKeyScopeState, summaries: Iterable<ApiCredentialSummary>): void {
  const normalizedSummaries = normalizeCredentialSummaries(Array.from(summaries));
  scope.summaries = normalizedSummaries;
  if (scope.credentialStore) {
    writeCredentialSecret(scope, API_CREDENTIALS_INDEX_KEY, JSON.stringify(normalizedSummaries));
    noteStoreWriteCommitted(scope);
    return;
  }
  if (scope.cache && canPersistEncryptedStore(scope)) persistEncryptedStore(scope, scope.cache);
}

function mergeCredentialSummaries(
  current: Iterable<ApiCredentialSummary>,
  legacyProviders: Iterable<string>,
  store: StoredKeys,
): ApiCredentialSummary[] {
  const summaries = new Map<string, ApiCredentialSummary>();
  for (const summary of current) summaries.set(summaryStorageKey(summary), summary);
  for (const provider of legacyProviders) {
    const normalizedProvider = normalizeProvider(provider);
    const key = credentialStorageKey(normalizedProvider);
    if (normalizedProvider && !summaries.has(key)) {
      summaries.set(key, legacyCredentialSummary(normalizedProvider, store[key]));
    }
  }
  for (const [credentialKey, value] of Object.entries(store)) {
    if (summaries.has(credentialKey)) continue;
    const parsed = parseCredentialStorageKey(credentialKey);
    if (!parsed) continue;
    summaries.set(credentialKey, parsed.credentialId === DEFAULT_CREDENTIAL_ID
      ? legacyCredentialSummary(parsed.provider, value)
      : {
          provider: parsed.provider,
          credentialId: parsed.credentialId,
          label: parsed.credentialId,
          source: "store",
          createdAt: LEGACY_CREDENTIAL_TIMESTAMP,
          updatedAt: LEGACY_CREDENTIAL_TIMESTAMP,
          maskedTail: maskCredentialKey(value),
        });
  }
  return Array.from(summaries.values());
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

function readCredentialStore(scope: ApiKeyScopeState, credentialCandidates: Iterable<string>): StoredKeys {
  const out: StoredKeys = {};
  for (const credentialKey of credentialCandidates) {
    const normalizedCredentialKey = normalizeCredentialStorageKey(credentialKey);
    if (!normalizedCredentialKey.length) continue;
    const value = readCredentialSecret(scope, credentialProviderKey(normalizedCredentialKey));
    if (value) out[normalizedCredentialKey] = value;
  }
  return out;
}

function mergeLegacyValuesIntoCredentialStore(
  scope: ApiKeyScopeState,
  currentStore: StoredKeys,
  legacyStore: StoredKeys,
): StoredKeys {
  const nextStore = { ...currentStore };
  const changedCredentialKeys = new Set<string>();
  for (const [credentialKey, rawValue] of Object.entries(legacyStore)) {
    const normalizedCredentialKey = normalizeCredentialStorageKey(credentialKey);
    const value = rawValue.trim();
    if (!normalizedCredentialKey.length || !value.length || nextStore[normalizedCredentialKey]) continue;
    writeCredentialSecret(scope, credentialProviderKey(normalizedCredentialKey), value);
    nextStore[normalizedCredentialKey] = value;
    changedCredentialKeys.add(normalizedCredentialKey);
  }
  if (changedCredentialKeys.size) {
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
    if (!scope.credentialStore) scope.summaries = [];
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
    const parsed = JSON.parse(decrypted) as unknown;
    if (!scope.credentialStore && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const metadata = (parsed as Record<string, unknown>)[API_CREDENTIALS_INDEX_KEY];
      scope.summaries = normalizeCredentialSummaries(metadata);
    }
    return normalizeStoredKeys(parsed);
  } catch {
    scope.decryptionFailed = true;
    return {};
  }
}

function deleteMacosKeychainSecretBestEffort(scope: ApiKeyScopeState, account: string): void {
  if (!isDefaultCredentialStorageKey(account)) return;
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
    scope.provenance = null;
    scope.missingCredentialProviders = new Set<string>();
  }
  scope.cacheStamp = stamp;
  ensureInitialized(scope);

  if (scope.credentialStore) {
    const providerIndex = readCredentialProviderIndex(scope);
    const credentialIndex = readApiCredentialIndex(scope);
    const credentialCandidates = new Set<string>(providerIndex.providers);
    for (const summary of credentialIndex.summaries) credentialCandidates.add(summaryStorageKey(summary));
    const credentialValues = readCredentialStore(scope, credentialCandidates);
    scope.cache = migrateLegacyStoresIntoCredentialStore(scope, credentialValues);
    const mergedSummaries = mergeCredentialSummaries(
      credentialIndex.summaries,
      providerIndex.providers,
      scope.cache,
    );
    const summariesChanged = JSON.stringify(mergedSummaries) !== JSON.stringify(credentialIndex.summaries);
    scope.summaries = mergedSummaries;
    if (summariesChanged) writeApiCredentialIndex(scope, mergedSummaries);
    else noteStoreWriteCommitted(scope);
    ensureProvenance(scope, Object.keys(scope.cache));
    return scope.cache;
  }

  const encryptedStore = loadEncryptedStore(scope);
  if (isMacosKeychainAvailable()) {
    if (canPersistEncryptedStore(scope)) {
      scope.cache = migrateLegacyMacosKeychainIntoEncryptedStore(scope, encryptedStore);
      const summaries = mergeCredentialSummaries(scope.summaries ?? [], [], scope.cache);
      if (JSON.stringify(summaries) !== JSON.stringify(scope.summaries ?? [])) writeApiCredentialIndex(scope, summaries);
      ensureProvenance(scope, Object.keys(scope.cache));
      return scope.cache;
    }

    const index = readMacosKeychainProviderIndex(scope);
    scope.cache = index.exists ? readMacosKeychainStore(scope, index.providers) : encryptedStore;
    scope.summaries = mergeCredentialSummaries(scope.summaries ?? [], index.providers, scope.cache);
    ensureProvenance(scope, Object.keys(scope.cache));
    return scope.cache;
  }

  scope.cache = encryptedStore;
  const summaries = mergeCredentialSummaries(scope.summaries ?? [], [], scope.cache);
  if (JSON.stringify(summaries) !== JSON.stringify(scope.summaries ?? [])) writeApiCredentialIndex(scope, summaries);
  ensureProvenance(scope, Object.keys(scope.cache));
  return scope.cache;
}

function purgeApiKeysMatching(
  scope: ApiKeyScopeState,
  predicate: (value: ApiKeyProvenance) => boolean,
): Set<string> {
  const store = ensureStore(scope);
  const summaries = scope.summaries ?? [];
  const metadata = ensureProvenance(scope, [...Object.keys(store), ...summaries.map(summaryStorageKey)]);
  const matched = Object.entries(metadata)
    .filter(([, value]) => predicate(value))
    .map(([credentialKey]) => credentialKey);
  if (!matched.length) return new Set();

  const nextStore = { ...store };
  for (const credentialKey of matched) {
    const parsedCredential = parseCredentialStorageKey(credentialKey);
    if (parsedCredential) {
      // WHY: deleting a secret without deleting the raw provider config leaves
      // a revoked key usable by a later harness launch.
      const cleanupOptions: PrivateTreeCleanupOptions = { logger: vaultLogger };
      removeCredentialLaunchHome(
        parsedCredential.provider,
        parsedCredential.credentialId,
        scope.launchHomeAdeDir ?? undefined,
        cleanupOptions,
      );
    }
    delete nextStore[credentialKey];
    if (scope.credentialStore) deleteCredentialSecret(scope, credentialProviderKey(credentialKey));
    delete metadata[credentialKey];
    scope.summaries = (scope.summaries ?? []).filter((summary) => summaryStorageKey(summary) !== credentialKey);
    scope.missingCredentialProviders.add(credentialKey);
    if (isDefaultCredentialStorageKey(credentialKey)) scope.missingMacosKeychainProviders.add(credentialKey);
  }
  if (scope.credentialStore) {
    const index = readCredentialProviderIndex(scope);
    writeCredentialProviderIndex(scope, index.providers.filter((provider) => !matched.includes(provider)));
    writeApiCredentialIndex(scope, scope.summaries ?? []);
  } else if (canPersistEncryptedStore(scope)) {
    persistEncryptedStore(scope, nextStore);
    for (const credentialKey of matched) deleteMacosKeychainSecretBestEffort(scope, credentialKey);
  }
  scope.cache = nextStore;
  persistProvenance(scope, metadata);
  return new Set(matched);
}

function purgeForeignAccountApiKeys(scope: ApiKeyScopeState): Set<string> {
  const currentUserId = getAccountUserId?.()?.trim() || null;
  return purgeApiKeysMatching(
    scope,
    (value) => value.source === "account" && value.accountUserId !== currentUserId,
  );
}

function persistEncryptedStore(scope: ApiKeyScopeState, nextStore: StoredKeys = scope.cache ?? {}): void {
  if (!scope.storePath) return;
  if (!isSecureStorageAvailable()) {
    throw new Error("OS secure storage is unavailable. Cannot persist API keys.");
  }
  fs.mkdirSync(path.dirname(scope.storePath), { recursive: true });
  const payload: Record<string, unknown> = { ...nextStore };
  if (scope.summaries !== null) payload[API_CREDENTIALS_INDEX_KEY] = scope.summaries;
  const encrypted = safeStorage!.encryptString(JSON.stringify(payload));
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
    launchHomeAdeDir: options.launchHomeAdeDir ?? resolveMachineAdeLayout().adeDir,
    storePath: layout.apiKeysPath,
    legacyStorePath: layout.legacyApiKeysPath,
    credentialStore: options.credentialStore ?? null,
  };
  getAccountVault = options.getAccountVault ?? null;
  getAccountUserId = options.getAccountUserId ?? null;
  vaultLogger = options.logger ?? null;
  productAnalytics = options.analytics ?? null;
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
    launchHomeAdeDir: resolveMachineAdeLayout().adeDir,
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
  if (options.launchHomeAdeDir !== undefined) {
    machineScopeState = {
      ...createMachineScopeState(),
      launchHomeAdeDir: options.launchHomeAdeDir,
    };
  }
}

/**
 * Both scopes can read one credential store, so a write through either must not
 * leave the other holding a cached "no key for this provider". Called before
 * the mutation — nothing can observe the gap, since the store is synchronous.
 */
function invalidatePeerScopeCache(scope: ApiKeyScopeState): void {
  if (scope === machineScopeState) {
    projectScope.cache = null;
    projectScope.summaries = null;
    projectScope.provenance = null;
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
  removeApiCredentialIn(machineScope(), provider, DEFAULT_CREDENTIAL_ID);
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

function findCaseInsensitiveCredentialCollision(
  scope: ApiKeyScopeState,
  provider: string,
  credentialId: string,
): { provider: string; credentialId: string } | null {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedCredentialId = normalizeCredentialId(credentialId);
  const normalizedCredentialIdLower = normalizedCredentialId.toLowerCase();
  const entries = [
    ...(scope.summaries ?? []).map((summary) => ({
      provider: normalizeProvider(summary.provider),
      credentialId: normalizeCredentialId(summary.credentialId),
    })),
    ...Object.keys(ensureStore(scope)).map((storageKey) => parseCredentialStorageKey(storageKey)).filter(
      (parsed): parsed is { provider: string; credentialId: string } => parsed !== null,
    ),
  ];
  return entries.find((entry) => entry.provider === normalizedProvider
    && entry.credentialId.toLowerCase() === normalizedCredentialIdLower
    && entry.credentialId !== normalizedCredentialId) ?? null;
}

function storeApiCredentialIn(
  scope: ApiKeyScopeState,
  args: ApiCredentialStoreArgs,
  options: ApiCredentialInternalOptions = {},
): string {
  const normalizedProvider = normalizeProvider(args.provider);
  const normalizedKey = args.key.trim();
  const normalizedCredentialId = args.credentialId === undefined
    ? generateCredentialId(args.label)
    : normalizeCredentialId(args.credentialId);
  if (!normalizedProvider || !normalizedCredentialId || !normalizedKey || !args.label.trim()) {
    if (args.credentialId !== undefined && !normalizedCredentialId) {
      throw new Error("Credential ids may contain only letters, digits, dot, underscore, and dash.");
    }
    if (!isSafeIdentifier(normalizedProvider)) {
      throw new Error("Provider ids may contain only letters, digits, dot, underscore, and dash.");
    }
    throw new Error("Provider, label, and key are required.");
  }
  const storageKey = credentialStorageKey(normalizedProvider, normalizedCredentialId);

  invalidatePeerScopeCache(scope);
  ensureStore(scope);
  if (scope === projectScope) purgeForeignAccountApiKeys(scope);
  const store = ensureStore(scope);
  const caseInsensitiveCollision = findCaseInsensitiveCredentialCollision(
    scope,
    normalizedProvider,
    normalizedCredentialId,
  );
  if (caseInsensitiveCollision) {
    throw new Error("A credential with this provider and id already exists (credential ids are case-insensitive).");
  }
  const previousSummary = (scope.summaries ?? []).find((summary) => summaryStorageKey(summary) === storageKey);
  const summary = buildCredentialSummary(
    args,
    normalizedProvider,
    normalizedCredentialId,
    previousSummary,
    normalizedKey,
  );
  upsertCredentialSummary(scope, summary);

  const source = options.source === "account" ? "account" : "device";
  const currentUserId = getAccountUserId?.()?.trim() || null;
  const accountUserId = source === "account"
    ? options.accountUserId?.trim() || currentUserId
    : null;
  const accountOwnerMatches = !getAccountUserId || accountUserId === currentUserId;
  const normalizedProvenance: ApiKeyProvenance = accountUserId && accountOwnerMatches
    ? { source: "account", accountUserId }
    : deviceCredentialProvenance();

  if (scope.credentialStore) {
    if (normalizedProvenance.source === "account") setProvenance(scope, storageKey, normalizedProvenance);
    writeCredentialSecret(scope, credentialProviderKey(storageKey), normalizedKey);
    store[storageKey] = normalizedKey;
    scope.missingCredentialProviders.delete(storageKey);
    if (normalizedCredentialId === DEFAULT_CREDENTIAL_ID) {
      const index = readCredentialProviderIndex(scope);
      writeCredentialProviderIndex(scope, new Set([...index.providers, normalizedProvider]));
    }
    writeApiCredentialIndex(scope, scope.summaries ?? []);
    if (normalizedProvenance.source !== "account") setProvenance(scope, storageKey, normalizedProvenance);
  } else {
    const nextStore = { ...store, [storageKey]: normalizedKey };
    if (normalizedProvenance.source === "account") setProvenance(scope, storageKey, normalizedProvenance);
    scope.cache = nextStore;
    persistEncryptedStore(scope, nextStore);
    deleteMacosKeychainSecretBestEffort(scope, storageKey);
    if (normalizedCredentialId === DEFAULT_CREDENTIAL_ID) {
      scope.missingMacosKeychainProviders.add(storageKey);
    }
    if (normalizedProvenance.source !== "account") setProvenance(scope, storageKey, normalizedProvenance);
  }
  if (normalizedCredentialId === DEFAULT_CREDENTIAL_ID && normalizedProvider === "cursor") {
    cursorKeyOrigin = "pasted";
  }
  if (!args.deviceOnly) {
    fireAndForgetVaultWrite(
      { getAccountVault: getAccountVault ?? undefined, logger: vaultLogger, logEvent: "ai.api_key_vault_sync_failed", context: { provider: storageKey } },
      "set",
      (vault) => vault.set("all", "provider_api_key", storageKey, normalizedKey),
    );
  }
  return storageKey;
}

function storeApiKeyIn(
  scope: ApiKeyScopeState,
  provider: string,
  key: string,
  options: ApiCredentialInternalOptions & { deviceOnly?: boolean } = {},
): void {
  storeApiCredentialIn(scope, {
    provider,
    credentialId: DEFAULT_CREDENTIAL_ID,
    label: normalizeProvider(provider),
    key,
    deviceOnly: options.deviceOnly,
  }, options);
}

export function storeApiKey(
  provider: string,
  key: string,
  options: {
    deviceOnly?: boolean;
    source?: "device" | "account";
    accountUserId?: string | null;
  } = {},
): void {
  storeApiKeyIn(projectScope, provider, key, options);
}

function getApiCredentialKeyIn(
  scope: ApiKeyScopeState,
  provider: string,
  credentialId = DEFAULT_CREDENTIAL_ID,
): string | null {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedCredentialId = normalizeCredentialId(credentialId);
  const storageKey = credentialStorageKey(normalizedProvider, normalizedCredentialId);
  if (!storageKey) return null;
  ensureStore(scope);
  if (scope === projectScope) purgeForeignAccountApiKeys(scope);
  const store = ensureStore(scope);
  const stored = store[storageKey];
  if (stored) return stored;
  if (scope.credentialStore && !scope.missingCredentialProviders.has(storageKey)) {
    const credentialValue = readCredentialSecret(scope, credentialProviderKey(storageKey));
    if (credentialValue) {
      store[storageKey] = credentialValue;
      if (normalizedCredentialId === DEFAULT_CREDENTIAL_ID) {
        const index = readCredentialProviderIndex(scope);
        writeCredentialProviderIndex(scope, new Set([...index.providers, normalizedProvider]));
      }
      ensureLegacyCredentialSummary(scope, storageKey, credentialValue);
      setProvenance(scope, storageKey, deviceCredentialProvenance());
      return credentialValue;
    }
    scope.missingCredentialProviders.add(storageKey);
  }
  const allowLegacyKeychainFallback =
    normalizedCredentialId === DEFAULT_CREDENTIAL_ID
    && (!scope.credentialStore || !isCredentialLegacyKeychainMigrated(scope));
  if (allowLegacyKeychainFallback && isMacosKeychainAvailable() && !scope.missingMacosKeychainProviders.has(storageKey)) {
    const keychainValue = readMacosKeychainSecret(scope, normalizedProvider);
    if (keychainValue) {
      store[storageKey] = keychainValue;
      ensureLegacyCredentialSummary(scope, storageKey, keychainValue);
      if (scope.credentialStore) {
        writeCredentialSecret(scope, credentialProviderKey(storageKey), keychainValue);
        const index = readCredentialProviderIndex(scope);
        writeCredentialProviderIndex(scope, new Set([...index.providers, normalizedProvider]));
        setProvenance(scope, storageKey, deviceCredentialProvenance());
      } else if (canPersistEncryptedStore(scope)) {
        persistEncryptedStore(scope, store);
        setProvenance(scope, storageKey, deviceCredentialProvenance());
      }
      return keychainValue;
    }
    scope.missingMacosKeychainProviders.add(storageKey);
  }
  if (normalizedCredentialId === DEFAULT_CREDENTIAL_ID) {
    const envVar = ENV_KEY_PROVIDERS[normalizedProvider];
    if (envVar) {
      const envValue = (process.env[envVar] ?? "").trim();
      if (envValue.length > 0) return envValue;
    }
  }
  return null;
}

function getApiKeyIn(scope: ApiKeyScopeState, provider: string): string | null {
  return getApiCredentialKeyIn(scope, provider, DEFAULT_CREDENTIAL_ID);
}

export function getApiKey(provider: string): string | null {
  return getApiKeyIn(projectScope, provider);
}

export function storeApiCredential(args: ApiCredentialStoreArgs): string {
  const storageKey = storeApiCredentialIn(projectScope, args);
  captureApiCredentialAnalytics({
    analytics: productAnalytics,
    surface: "api",
    action: "credential_stored",
    provider: args.provider,
  });
  return parseCredentialStorageKey(storageKey)?.credentialId ?? DEFAULT_CREDENTIAL_ID;
}

export function getApiCredentialKey(provider: string, credentialId = DEFAULT_CREDENTIAL_ID): string | null {
  return getApiCredentialKeyIn(projectScope, provider, credentialId);
}

export function listApiCredentials(provider?: string): ApiCredentialSummary[] {
  ensureStore(projectScope);
  purgeForeignAccountApiKeys(projectScope);
  return storedCredentialSummaries(projectScope, provider);
}

export function getApiCredentialSummary(
  provider: string,
  credentialId = DEFAULT_CREDENTIAL_ID,
): ApiCredentialSummary | null {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedCredentialId = normalizeCredentialId(credentialId);
  if (!normalizedProvider || !normalizedCredentialId) return null;
  return listApiCredentials(normalizedProvider)
    .find((summary) => summary.credentialId === normalizedCredentialId) ?? null;
}

function removeApiCredentialIn(
  scope: ApiKeyScopeState,
  provider: string,
  credentialId = DEFAULT_CREDENTIAL_ID,
): void {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedCredentialId = normalizeCredentialId(credentialId);
  const storageKey = credentialStorageKey(normalizedProvider, normalizedCredentialId);
  if (!storageKey) return;
  invalidatePeerScopeCache(scope);
  ensureStore(scope);
  if (scope === projectScope && purgeForeignAccountApiKeys(scope).has(storageKey)) return;
  const store = ensureStore(scope);
  if (normalizedCredentialId === DEFAULT_CREDENTIAL_ID && normalizedProvider === "cursor") cursorKeyOrigin = null;
  scope.summaries = (scope.summaries ?? []).filter((summary) => summaryStorageKey(summary) !== storageKey);
  if (scope.credentialStore) {
    deleteCredentialSecret(scope, credentialProviderKey(storageKey));
    delete store[storageKey];
    scope.missingCredentialProviders.add(storageKey);
    if (normalizedCredentialId === DEFAULT_CREDENTIAL_ID) {
      const index = readCredentialProviderIndex(scope);
      writeCredentialProviderIndex(scope, index.providers.filter((entry) => entry !== normalizedProvider));
    }
    writeApiCredentialIndex(scope, scope.summaries);
  } else {
    const nextStore = { ...store };
    delete nextStore[storageKey];
    if (canPersistEncryptedStore(scope)) {
      persistEncryptedStore(scope, nextStore);
    }
    deleteMacosKeychainSecretBestEffort(scope, storageKey);
    if (normalizedCredentialId === DEFAULT_CREDENTIAL_ID) {
      scope.missingMacosKeychainProviders.add(storageKey);
    }
    scope.cache = nextStore;
    noteStoreWriteCommitted(scope);
  }
  deleteProvenance(scope, storageKey);
  removeCredentialLaunchHome(
    normalizedProvider,
    normalizedCredentialId,
    scope.launchHomeAdeDir ?? undefined,
    { logger: vaultLogger },
  );
  if (scope === projectScope) {
    fireAndForgetVaultWrite(
      { getAccountVault: getAccountVault ?? undefined, logger: vaultLogger, logEvent: "ai.api_key_vault_sync_failed", context: { provider: storageKey } },
      "remove",
      (vault) => vault.remove("all", "provider_api_key", storageKey),
    );
  }
}

export function removeApiCredential(provider: string, credentialId = DEFAULT_CREDENTIAL_ID): void {
  removeApiCredentialIn(projectScope, provider, credentialId);
  captureApiCredentialAnalytics({
    analytics: productAnalytics,
    surface: "api",
    action: "credential_removed",
    provider,
  });
}

export function deleteApiKey(provider: string): void {
  removeApiCredentialIn(projectScope, provider, DEFAULT_CREDENTIAL_ID);
}

function listStoredProvidersIn(scope: ApiKeyScopeState): string[] {
  ensureStore(scope);
  if (scope === projectScope) purgeForeignAccountApiKeys(scope);
  return Object.keys(ensureStore(scope))
    .filter((storageKey) => isDefaultCredentialStorageKey(storageKey))
    .map((storageKey) => parseCredentialStorageKey(storageKey)?.provider)
    .filter((provider): provider is string => Boolean(provider));
}

export function listStoredProviders(): string[] {
  return listStoredProvidersIn(projectScope);
}

/** Return persisted origin metadata without exposing the credential itself. */
export function getApiKeyProvenance(provider: string): ApiKeyProvenance {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider.length) return deviceCredentialProvenance();
  ensureStore(projectScope);
  purgeForeignAccountApiKeys(projectScope);
  const store = ensureStore(projectScope);
  return ensureProvenance(projectScope, Object.keys(store))[normalizedProvider] ?? deviceCredentialProvenance();
}

/** Remove account-hydrated provider keys while retaining device-origin keys. */
export function purgeAccountApiKeys(): void {
  purgeApiKeysMatching(projectScope, (value) => value.source === "account");
}

/**
 * Copy account-scoped provider keys into the local store without replacing a
 * value this machine already has. The vault list intentionally omits secret
 * values, so readable rows are fetched individually before they are stored.
 */
export async function hydrateApiKeysFromVault(): Promise<ApiKeyHydrationResult> {
  const collisions: ApiKeyHydrationCollision[] = [];
  const accountUserId = getAccountUserId?.()?.trim() || null;
  if (!accountUserId) return { collisions };
  const vault = resolveAccountVault("list", "*");
  if (!vault) return { collisions };

  let listed: Awaited<ReturnType<AccountVaultBridge["list"]>>;
  try {
    listed = await vault.list("all");
  } catch (error) {
    logVaultFailure("list", "*", error);
    return { collisions };
  }
  if (!listed.ok) {
    logVaultFailure("list", "*", listed);
    return { collisions };
  }

  for (const item of listed.value) {
    if (item.scope !== "all" || item.kind !== "provider_api_key") continue;
    const parsed = parseCredentialStorageKey(item.key);
    if (!parsed) continue;
    const storageKey = credentialStorageKey(parsed.provider, parsed.credentialId);

    let value = typeof item.value === "string" ? item.value.trim() : "";
    if (!value.length) {
      let fetched: Awaited<ReturnType<AccountVaultBridge["get"]>>;
      try {
        fetched = await vault.get("all", "provider_api_key", storageKey);
      } catch (error) {
        logVaultFailure("get", storageKey, error);
        continue;
      }
      if (!fetched.ok) {
        logVaultFailure("get", storageKey, fetched);
        continue;
      }
      value = fetched.value?.trim() ?? "";
    }
    if (!value.length) continue;
    if ((getAccountUserId?.()?.trim() || null) !== accountUserId) return { collisions };

    try {
      if (getApiCredentialKey(parsed.provider, parsed.credentialId)) continue;
      const caseInsensitiveCollision = findCaseInsensitiveCredentialCollision(
        projectScope,
        parsed.provider,
        parsed.credentialId,
      );
      if (caseInsensitiveCollision) {
        const collision: ApiKeyHydrationCollision = {
          provider: parsed.provider,
          credentialId: parsed.credentialId,
          existingCredentialId: caseInsensitiveCollision.credentialId,
          storageKey,
        };
        collisions.push(collision);
        logHydrationCollision(collision);
        continue;
      }
      storeApiCredentialIn(projectScope, {
        provider: parsed.provider,
        credentialId: parsed.credentialId,
        label: parsed.credentialId === DEFAULT_CREDENTIAL_ID ? parsed.provider : parsed.credentialId,
        key: value,
        deviceOnly: true,
      }, {
        source: "account",
        accountUserId,
      });
    } catch (error) {
      logVaultFailure("hydrate", storageKey, error);
    }
  }
  return { collisions };
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
  ensureStore(projectScope);
  purgeForeignAccountApiKeys(projectScope);
  return Object.fromEntries(
    Object.entries(ensureStore(projectScope))
      .map(([storageKey, key]) => {
        const parsed = parseCredentialStorageKey(storageKey);
        return parsed?.credentialId === DEFAULT_CREDENTIAL_ID ? [parsed.provider, key] : null;
      })
      .filter((entry): entry is [string, string] => entry !== null),
  );
}
