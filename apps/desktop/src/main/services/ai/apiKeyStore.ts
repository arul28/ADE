import fs from "node:fs";
import path from "node:path";
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

export type ApiKeyStoreStatus = {
  secureStorageAvailable: boolean;
  encryptedStorePath: string | null;
  legacyPlaintextDetected: boolean;
  legacyPlaintextPath: string | null;
  decryptionFailed: boolean;
};

let storePath: string | null = null;
let legacyStorePath: string | null = null;
let cache: StoredKeys | null = null;
let decryptionFailed = false;

function isSecureStorageAvailable(): boolean {
  return Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === "function" && safeStorage.isEncryptionAvailable());
}

function normalizeStoredKeys(value: unknown): StoredKeys {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: StoredKeys = {};
  for (const [provider, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue !== "string") continue;
    const normalizedProvider = provider.trim().toLowerCase();
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

function ensureStore(): StoredKeys {
  if (cache) return cache;
  ensureInitialized();

  if (!storePath || !legacyStorePath) {
    cache = {};
    return cache;
  }

  if (!fs.existsSync(storePath)) {
    decryptionFailed = false;
    cache = {};
    return cache;
  }

  if (!isSecureStorageAvailable()) {
    decryptionFailed = true;
    cache = {};
    return cache;
  }

  try {
    const raw = fs.readFileSync(storePath);
    const decrypted = safeStorage!.decryptString(raw);
    cache = normalizeStoredKeys(JSON.parse(decrypted));
    decryptionFailed = false;
    return cache;
  } catch {
    decryptionFailed = true;
    cache = {};
    return cache;
  }
}

function persist(): void {
  if (!storePath || !cache) return;
  if (!isSecureStorageAvailable()) {
    throw new Error("OS secure storage is unavailable. Cannot persist API keys.");
  }
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const encrypted = safeStorage!.encryptString(JSON.stringify(cache));
  fs.writeFileSync(storePath, encrypted);
  try {
    fs.chmodSync(storePath, 0o600);
  } catch {
    // Best effort
  }
}

export function initApiKeyStore(projectRoot: string): void {
  const layout = resolveAdeLayout(projectRoot);
  storePath = layout.apiKeysPath;
  legacyStorePath = layout.legacyApiKeysPath;
  cache = null;
  decryptionFailed = false;
}

export function getApiKeyStoreStatus(): ApiKeyStoreStatus {
  if (!storePath || !legacyStorePath) {
    return {
      secureStorageAvailable: isSecureStorageAvailable(),
      encryptedStorePath: null,
      legacyPlaintextDetected: false,
      legacyPlaintextPath: null,
      decryptionFailed,
    };
  }
  return {
    secureStorageAvailable: isSecureStorageAvailable(),
    encryptedStorePath: storePath,
    legacyPlaintextDetected: Boolean(legacyStorePath && fs.existsSync(legacyStorePath)),
    legacyPlaintextPath: legacyStorePath && fs.existsSync(legacyStorePath) ? legacyStorePath : null,
    decryptionFailed,
  };
}

export function storeApiKey(provider: string, key: string): void {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedKey = key.trim();
  if (!normalizedProvider.length || !normalizedKey.length) {
    throw new Error("Provider and key are required.");
  }
  const store = ensureStore();
  store[normalizedProvider] = normalizedKey;
  persist();
}

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
};

export function getApiKey(provider: string): string | null {
  const normalizedProvider = provider.trim().toLowerCase();
  if (!normalizedProvider.length) return null;
  const store = ensureStore();
  const stored = store[normalizedProvider];
  if (stored) return stored;
  const envVar = ENV_KEY_PROVIDERS[normalizedProvider];
  if (envVar) {
    const envValue = (process.env[envVar] ?? "").trim();
    if (envValue.length > 0) return envValue;
  }
  return null;
}

export function deleteApiKey(provider: string): void {
  const normalizedProvider = provider.trim().toLowerCase();
  if (!normalizedProvider.length) return;
  const store = ensureStore();
  delete store[normalizedProvider];
  persist();
}

export function listStoredProviders(): string[] {
  const store = ensureStore();
  return Object.keys(store);
}

export function getAllApiKeys(): Record<string, string> {
  return { ...ensureStore() };
}
