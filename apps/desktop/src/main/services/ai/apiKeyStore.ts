import fs from "node:fs";
import path from "node:path";

/**
 * Simple file-based API key store.
 * In a future iteration, this should use Electron's safeStorage API
 * for proper OS keychain integration.
 */

type StoredKeys = Record<string, string>;

let storePath: string | null = null;
let cache: StoredKeys | null = null;

function ensureStore(): StoredKeys {
  if (cache) return cache;
  if (!storePath) throw new Error("API key store not initialized. Call initApiKeyStore first.");

  try {
    if (fs.existsSync(storePath)) {
      const raw = fs.readFileSync(storePath, "utf8");
      cache = JSON.parse(raw) as StoredKeys;
      return cache;
    }
  } catch {
    // Corrupt file, start fresh
  }

  cache = {};
  return cache;
}

function persist(): void {
  if (!storePath || !cache) return;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(cache, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function initApiKeyStore(adeDir: string): void {
  storePath = path.join(adeDir, "api-keys.json");
}

export function storeApiKey(provider: string, key: string): void {
  const store = ensureStore();
  store[provider] = key;
  persist();
}

export function getApiKey(provider: string): string | null {
  const store = ensureStore();
  return store[provider] ?? null;
}

export function deleteApiKey(provider: string): void {
  const store = ensureStore();
  delete store[provider];
  persist();
}

export function listStoredProviders(): string[] {
  const store = ensureStore();
  return Object.keys(store);
}

export function getAllApiKeys(): Record<string, string> {
  return { ...ensureStore() };
}
