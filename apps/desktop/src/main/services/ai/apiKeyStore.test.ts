import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const safeStorageState = vi.hoisted(() => ({
  available: false,
  decrypted: "{}",
  encrypted: Buffer.from("encrypted"),
}));

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

vi.mock("electron", () => ({
  default: {
    safeStorage: {
      isEncryptionAvailable: () => safeStorageState.available,
      decryptString: () => safeStorageState.decrypted,
      encryptString: () => safeStorageState.encrypted,
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => safeStorageState.available,
    decryptString: () => safeStorageState.decrypted,
    encryptString: () => safeStorageState.encrypted,
  },
}));

const originalPlatform = process.platform;
const originalEnv = { ...process.env };

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

function securityArg(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? "" : "";
}

function securityAccountsFor(command: string): string[] {
  return spawnSyncMock.mock.calls
    .map((call) => (call[1] as string[]).map(String))
    .filter((args) => args[0] === command)
    .map((args) => securityArg(args, "-a"));
}

function securityCommandCalls(command: string): string[][] {
  return spawnSyncMock.mock.calls
    .map((call) => (call[1] as string[]).map(String))
    .filter((args) => args[0] === command);
}

function installSecurityMock(
  keychain: Map<string, string>,
  options: { failProviderIndexWrites?: boolean } = {},
): void {
  spawnSyncMock.mockImplementation((_command: string, rawArgs: string[]) => {
    const args = rawArgs.map(String);
    const command = args[0];
    const account = securityArg(args, "-a");
    if (command === "find-generic-password") {
      if (!keychain.has(account)) {
        return {
          status: 44,
          stdout: "",
          stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
        };
      }
      return {
        status: 0,
        stdout: `${keychain.get(account) ?? ""}\n`,
        stderr: "",
      };
    }
    if (command === "add-generic-password") {
      if (options.failProviderIndexWrites && account === "__ade_provider_index__") {
        return { status: 1, stdout: "", stderr: "provider index write failed" };
      }
      keychain.set(account, securityArg(args, "-w"));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "delete-generic-password") {
      if (!keychain.has(account)) {
        return {
          status: 44,
          stdout: "",
          stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
        };
      }
      keychain.delete(account);
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected security command ${command}` };
  });
}

async function loadStoreModule() {
  vi.resetModules();
  const mod = await import("./apiKeyStore");
  mod.__setSafeStorageForTests({
    isEncryptionAvailable: () => safeStorageState.available,
    decryptString: () => safeStorageState.decrypted,
    encryptString: () => safeStorageState.encrypted,
  } as never);
  return mod;
}

class MemoryCredentialStore {
  readonly values = new Map<string, string>();

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
    return this.values.get(key) ?? null;
  }

  setSync(key: string, value: string): void {
    this.values.set(key, value);
  }

  deleteSync(key: string): void {
    this.values.delete(key);
  }
}

function createVaultMock() {
  return {
    list: vi.fn(async () => ({ ok: true, value: [] })),
    get: vi.fn(async () => ({ ok: true, value: null })),
    set: vi.fn(async () => ({ ok: true, value: null })),
    remove: vi.fn(async () => ({ ok: true, value: null })),
    sync: vi.fn(async () => ({ ok: true, value: null })),
  };
}

describe("apiKeyStore", () => {
  let tempRoot: string;
  let keychain: Map<string, string>;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    safeStorageState.available = false;
    safeStorageState.decrypted = "{}";
    safeStorageState.encrypted = Buffer.from("encrypted");
    keychain = new Map();
    installSecurityMock(keychain);

    process.env = { ...originalEnv, ADE_API_KEY_STORE_FORCE_KEYCHAIN: "1" };
    delete process.env.ADE_API_KEY_STORE_DISABLE_KEYCHAIN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.CURSOR_API_KEY;
    setPlatform("darwin");
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-api-key-store-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    process.env = { ...originalEnv };
    setPlatform(originalPlatform);
    vi.resetModules();
  });

  it("stores Cursor keys in safeStorage without writing secrets to macOS Keychain argv", async () => {
    safeStorageState.available = true;
    safeStorageState.decrypted = "{}";
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot);

    store.storeApiKey("cursor", " crsr_test_key ");

    expect(store.getApiKey("cursor")).toBe("crsr_test_key");
    expect(store.listStoredProviders()).toContain("cursor");
    expect(keychain.has("cursor")).toBe(false);
    expect(securityCommandCalls("add-generic-password")).toEqual([]);
    expect(fs.existsSync(path.join(tempRoot, ".ade", "secrets", "api-keys.v1.bin"))).toBe(true);
  });

  it("migrates legacy Keychain keys into safeStorage without writing back to Keychain", async () => {
    safeStorageState.available = true;
    safeStorageState.decrypted = "{}";
    keychain.set("__ade_provider_index__", JSON.stringify(["cursor"]));
    keychain.set("cursor", "crsr_keychain_key");
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot);

    expect(store.getApiKey("cursor")).toBe("crsr_keychain_key");
    expect(store.listStoredProviders()).toContain("cursor");
    expect(securityCommandCalls("add-generic-password")).toEqual([]);
    expect(fs.existsSync(path.join(tempRoot, ".ade", "secrets", "api-keys.v1.bin"))).toBe(true);
  });

  it("updates safeStorage and deletes any stale legacy Keychain copy", async () => {
    safeStorageState.available = true;
    safeStorageState.decrypted = "{}";
    keychain.set("__ade_provider_index__", JSON.stringify(["cursor"]));
    keychain.set("cursor", "crsr_old_key");
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot);

    store.storeApiKey("cursor", "crsr_new_key");

    expect(store.getApiKey("cursor")).toBe("crsr_new_key");
    expect(keychain.has("cursor")).toBe(false);
    expect(securityCommandCalls("add-generic-password")).toEqual([]);
    expect(store.getApiKeyStoreStatus().macosKeychainError).toBeNull();
  });

  it("removes a deleted legacy Keychain key from memory and the active encrypted store", async () => {
    safeStorageState.available = true;
    safeStorageState.decrypted = "{}";
    keychain.set("__ade_provider_index__", JSON.stringify(["cursor"]));
    keychain.set("cursor", "crsr_test_key");
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot);

    expect(store.getApiKey("cursor")).toBe("crsr_test_key");

    store.deleteApiKey("cursor");

    expect(store.getApiKey("cursor")).toBeNull();
    expect(store.listStoredProviders()).not.toContain("cursor");
    expect(keychain.has("cursor")).toBe(false);
    expect(securityCommandCalls("add-generic-password")).toEqual([]);
  });

  it("keeps a decryptable legacy safeStorage blob as the active store", async () => {
    const secretsDir = path.join(tempRoot, ".ade", "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, "api-keys.v1.bin"), Buffer.from("old-encrypted"));
    safeStorageState.available = true;
    safeStorageState.decrypted = JSON.stringify({
      cursor: "crsr_old_key",
      openai: "openai_old_key",
    });

    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot);

    expect(store.getApiKey("cursor")).toBe("crsr_old_key");
    expect(store.getApiKey("openai")).toBe("openai_old_key");
    expect(keychain.has("cursor")).toBe(false);
    expect(keychain.has("openai")).toBe(false);
    expect(securityCommandCalls("add-generic-password")).toEqual([]);
  });

  it("preserves an existing encrypted-store value over a stale Keychain migration fallback", async () => {
    keychain.set("cursor", "crsr_stale_key");
    const secretsDir = path.join(tempRoot, ".ade", "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, "api-keys.v1.bin"), Buffer.from("old-encrypted"));
    safeStorageState.available = true;
    safeStorageState.decrypted = JSON.stringify({ cursor: "crsr_current_key" });

    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot);

    expect(store.getApiKey("cursor")).toBe("crsr_current_key");
    expect(keychain.get("cursor")).toBe("crsr_stale_key");
    expect(securityCommandCalls("add-generic-password")).toEqual([]);
  });

  it("keeps Keychain keys usable when the old encrypted blob cannot be decrypted", async () => {
    keychain.set("__ade_provider_index__", JSON.stringify(["cursor"]));
    keychain.set("cursor", "crsr_keychain_key");
    const secretsDir = path.join(tempRoot, ".ade", "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, "api-keys.v1.bin"), Buffer.from("unreadable"));
    safeStorageState.available = false;

    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot);

    expect(store.getApiKey("cursor")).toBe("crsr_keychain_key");
    expect(store.getApiKeyStoreStatus()).toMatchObject({
      secureStorageAvailable: false,
      macosKeychainAvailable: true,
      decryptionFailed: true,
    });
  });

  it("uses the Keychain provider index instead of probing every known provider on cold load", async () => {
    keychain.set("__ade_provider_index__", JSON.stringify(["cursor"]));
    keychain.set("cursor", "crsr_keychain_key");

    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot);

    expect(store.getApiKey("cursor")).toBe("crsr_keychain_key");
    expect(store.listStoredProviders()).toEqual(["cursor"]);
    expect(securityAccountsFor("find-generic-password")).toEqual([
      "__ade_provider_index__",
      "cursor",
    ]);
  });

  it("reads an unindexed Keychain provider on demand without scanning unrelated providers", async () => {
    keychain.set("cursor", "crsr_unindexed_key");

    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot);

    expect(store.getApiKey("cursor")).toBe("crsr_unindexed_key");
    expect(store.listStoredProviders()).toEqual(["cursor"]);
    expect(securityAccountsFor("find-generic-password")).toEqual([
      "__ade_provider_index__",
      "cursor",
    ]);
    expect(securityCommandCalls("add-generic-password")).toEqual([]);
  });

  it("migrates legacy safeStorage API keys into a provided credential store once", async () => {
    delete process.env.OPENAI_API_KEY;
    const secretsDir = path.join(tempRoot, ".ade", "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, "api-keys.v1.bin"), Buffer.from("old-encrypted"));
    safeStorageState.available = true;
    safeStorageState.decrypted = JSON.stringify({
      cursor: "crsr_old_key",
      openai: "openai_old_key",
    });
    const credentialStore = new MemoryCredentialStore();
    const store = await loadStoreModule();

    store.initApiKeyStore(tempRoot, { credentialStore });

    expect(store.getApiKey("cursor")).toBe("crsr_old_key");
    expect(store.getApiKey("openai")).toBe("openai_old_key");
    expect(credentialStore.values.get("ai.api_key.cursor.v1")).toBe("crsr_old_key");
    expect(credentialStore.values.get("ai.api_key.openai.v1")).toBe("openai_old_key");

    store.deleteApiKey("openai");
    store.initApiKeyStore(tempRoot, { credentialStore });

    expect(store.getApiKey("openai")).toBeNull();
    expect(store.listStoredProviders()).toEqual(["cursor"]);
  });

  it("migrates legacy Keychain API keys into a provided credential store", async () => {
    keychain.set("__ade_provider_index__", JSON.stringify(["cursor"]));
    keychain.set("cursor", "crsr_keychain_key");
    const credentialStore = new MemoryCredentialStore();
    const store = await loadStoreModule();

    store.initApiKeyStore(tempRoot, { credentialStore });

    expect(store.getApiKey("cursor")).toBe("crsr_keychain_key");
    expect(credentialStore.values.get("ai.api_key.cursor.v1")).toBe("crsr_keychain_key");
    expect(JSON.parse(credentialStore.values.get("ai.api_key.index.v1") ?? "[]")).toEqual(["cursor"]);

    store.deleteApiKey("cursor");
    store.initApiKeyStore(tempRoot, { credentialStore });

    expect(store.getApiKey("cursor")).toBeNull();
  });

  it("stores, lists, returns, and deletes API keys through a provided credential store", async () => {
    delete process.env.OPENAI_API_KEY;
    const credentialStore = new MemoryCredentialStore();
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, { credentialStore });

    store.storeApiKey(" OpenAI ", " sk-test-key ");
    store.storeApiKey("CURSOR", " crsr_test_key ");

    expect(store.getApiKey("openai")).toBe("sk-test-key");
    expect(store.getAllApiKeys()).toEqual({
      cursor: "crsr_test_key",
      openai: "sk-test-key",
    });
    expect(store.listStoredProviders().sort()).toEqual(["cursor", "openai"]);
    expect(credentialStore.values.get("ai.api_key.openai.v1")).toBe("sk-test-key");
    expect(credentialStore.values.get("ai.api_key.cursor.v1")).toBe("crsr_test_key");
    expect(JSON.parse(credentialStore.values.get("ai.api_key.index.v1") ?? "[]")).toEqual(["cursor", "openai"]);
    expect(keychain.size).toBe(0);

    store.deleteApiKey("OPENAI");

    expect(store.getApiKey("openai")).toBeNull();
    expect(store.getAllApiKeys()).toEqual({ cursor: "crsr_test_key" });
    expect(store.listStoredProviders()).toEqual(["cursor"]);
    expect(credentialStore.values.has("ai.api_key.openai.v1")).toBe(false);
    expect(JSON.parse(credentialStore.values.get("ai.api_key.index.v1") ?? "[]")).toEqual(["cursor"]);
  });

  it("synthesizes a default credential summary from the legacy provider index", async () => {
    delete process.env.OPENAI_API_KEY;
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("ai.api_key.index.v1", JSON.stringify(["openai"]));
    credentialStore.setSync("ai.api_key.openai.v1", "sk-legacy-key");
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, { credentialStore });

    expect(store.getApiCredentialKey("openai", "default")).toBe("sk-legacy-key");
    expect(store.getApiCredentialSummary("openai", "default")).toEqual(expect.objectContaining({
      provider: "openai",
      credentialId: "default",
      source: "store",
      maskedTail: "••••-key",
    }));
    expect(JSON.parse(credentialStore.values.get("ai.api_credentials.index.v1") ?? "[]")).toEqual([
      expect.objectContaining({ provider: "openai", credentialId: "default" }),
    ]);
  });

  it("stores and removes a second credential without exposing its secret in metadata", async () => {
    delete process.env.OPENAI_API_KEY;
    const credentialStore = new MemoryCredentialStore();
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, { credentialStore });

    store.storeApiKey("openai", "sk-default-secret");
    const credentialId = store.storeApiCredential({
      provider: " OpenAI ",
      label: "Open Router",
      key: "sk-secondary-secret",
      baseUrl: "https://openrouter.ai/api/v1",
      protocol: "openai-compatible",
      models: ["openai/gpt-4o", " openai/gpt-4o "],
    });

    expect(credentialId).toMatch(/^open-router-[0-9a-f]{6}$/);
    expect(store.getApiCredentialKey("openai", credentialId)).toBe("sk-secondary-secret");
    expect(store.getApiKey("openai")).toBe("sk-default-secret");
    expect(store.listStoredProviders()).toEqual(["openai"]);
    expect(store.getAllApiKeys()).toEqual({ openai: "sk-default-secret" });
    expect(store.getApiCredentialSummary("openai", credentialId)).toEqual(expect.objectContaining({
      provider: "openai",
      credentialId,
      label: "Open Router",
      baseUrl: "https://openrouter.ai/api/v1",
      protocol: "openai-compatible",
      models: ["openai/gpt-4o"],
      source: "store",
      maskedTail: "••••cret",
    }));
    const metadata = credentialStore.values.get("ai.api_credentials.index.v1") ?? "";
    expect(metadata).toContain("openrouter.ai");
    expect(JSON.parse(credentialStore.values.get("ai.api_key.index.v1") ?? "[]")).toEqual(["openai"]);
    expect(metadata).not.toContain("sk-secondary-secret");
    expect(metadata).not.toContain("sk-default-secret");
    expect(credentialStore.values.get(`ai.api_key.openai#${credentialId}.v1`)).toBe("sk-secondary-secret");

    store.removeApiCredential("openai", credentialId);

    expect(store.getApiCredentialKey("openai", credentialId)).toBeNull();
    expect(store.getApiCredentialSummary("openai", credentialId)).toBeNull();
    expect(store.getApiKey("openai")).toBe("sk-default-secret");
    expect(credentialStore.values.has(`ai.api_key.openai#${credentialId}.v1`)).toBe(false);
  });

  it("only reports a credential removal that actually removed something", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const analytics = { captureInternal: (input: unknown) => { captured.push(input as Record<string, unknown>); } };
    const credentialStore = new MemoryCredentialStore();
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, { credentialStore, analytics });

    // Removing what was never stored is a no-op, not a completed removal:
    // capturing it would inflate the funnel with phantom events.
    store.removeApiCredential("openai", "never-stored");
    expect(captured).toEqual([]);

    store.storeApiKey("openai", "sk-real-secret");
    store.removeApiCredential("openai");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      properties: { feature: "api_credentials", action: "credential_removed", outcome: "completed" },
    });

    // The cleanup is idempotent, so a second remove must stay silent.
    store.removeApiCredential("openai");
    expect(captured).toHaveLength(1);
  });

  it("exports one canonical storage key so other packages cannot re-derive it", async () => {
    const store = await loadStoreModule();
    expect(store.credentialStorageKey("OpenAI")).toBe("openai");
    expect(store.credentialStorageKey("openai", "open-router-a1b2c3")).toBe("openai#open-router-a1b2c3");
    // Unsafe or separator-bearing ids resolve to no key at all rather than to
    // a key that would address a different credential.
    expect(store.credentialStorageKey("openai", "a#b")).toBe("");
    expect(store.credentialStorageKey("openai", "../escape")).toBe("");
    expect(store.credentialStorageKey("", "default")).toBe("");
    expect(store.API_CREDENTIALS_INDEX_KEY).toBe("ai.api_credentials.index.v1");
  });

  it("rejects credential ids that collide case-insensitively for one provider", async () => {
    delete process.env.OPENAI_API_KEY;
    const credentialStore = new MemoryCredentialStore();
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, { credentialStore });

    store.storeApiCredential({
      provider: "openai",
      credentialId: "Work",
      label: "Work",
      key: "sk-work",
    });

    expect(() => store.storeApiCredential({
      provider: "OPENAI",
      credentialId: "work",
      label: "Another Work",
      key: "sk-another-work",
    })).toThrow(/case-insensitive/);
    expect(store.getApiCredentialKey("openai", "Work")).toBe("sk-work");
  });


  it("attributes environment fallback only to the default credential", async () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    const credentialStore = new MemoryCredentialStore();
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, { credentialStore });

    expect(store.listApiCredentials("openai")).toEqual([
      expect.objectContaining({
        provider: "openai",
        credentialId: "default",
        source: "env",
        envVar: "OPENAI_API_KEY",
      }),
    ]);
    expect(store.getApiCredentialSummary("openai", "default")?.source).toBe("env");
    expect(store.getApiCredentialSummary("openai", "alternate")).toBeNull();
  });

  it("does not treat malformed credential migration metadata as a decryption failure", async () => {
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("ai.api_key.index.v1", JSON.stringify(["cursor"]));
    credentialStore.setSync("ai.api_key.cursor.v1", "crsr_test_key");
    credentialStore.setSync("ai.credentials.legacy_projects_migrated.v1", "{broken-json");
    const store = await loadStoreModule();

    store.initApiKeyStore(tempRoot, { credentialStore });

    expect(store.getApiKey("cursor")).toBe("crsr_test_key");
    expect(store.getApiKeyStoreStatus()).toMatchObject({
      decryptionFailed: false,
    });
  });

  it("reads an unindexed credential-store provider on demand and updates the index", async () => {
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("ai.api_key.openai.v1", "sk-unindexed-key");
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, { credentialStore });

    expect(store.listStoredProviders()).toEqual([]);
    expect(store.getApiKey("OPENAI")).toBe("sk-unindexed-key");

    expect(store.listStoredProviders()).toEqual(["openai"]);
    expect(JSON.parse(credentialStore.values.get("ai.api_key.index.v1") ?? "[]")).toEqual(["openai"]);
  });

  it("deletes from memory without throwing when persistent secure storage is unavailable", async () => {
    safeStorageState.available = true;
    safeStorageState.decrypted = "{}";
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot);
    store.storeApiKey("cursor", "crsr_test_key");

    safeStorageState.available = false;
    process.env.ADE_API_KEY_STORE_DISABLE_KEYCHAIN = "1";

    expect(() => store.deleteApiKey("cursor")).not.toThrow();
    expect(store.getApiKey("cursor")).toBeNull();
    expect(store.listStoredProviders()).toEqual([]);
  });

  it("can use the ADE CLI encrypted credential store without persisting the raw key", async () => {
    process.env.ADE_API_KEY_STORE_DISABLE_KEYCHAIN = "1";
    const credentialsPath = path.join(tempRoot, "credentials.json.enc");
    const machineKeyPath = path.join(tempRoot, ".machine-key");
    const { EncryptedFileCredentialStore } = await import("../../../../../ade-cli/src/services/credentials/credentialStore");
    const credentialStore = new EncryptedFileCredentialStore({ credentialsPath, machineKeyPath });
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, { credentialStore });

    store.storeApiKey("OpenAI", "sk-raw-secret-value");

    expect(store.getApiKey("openai")).toBe("sk-raw-secret-value");
    expect(store.listStoredProviders()).toEqual(["openai"]);
    const persisted = fs.readFileSync(credentialsPath, "utf8");
    expect(persisted).toContain("ciphertext");
    expect(persisted).not.toContain("sk-raw-secret-value");
    expect(fs.existsSync(path.join(tempRoot, ".ade", "secrets", "api-keys.v1.bin"))).toBe(false);
    expect(store.getApiKeyStoreStatus()).toMatchObject({
      secureStorageAvailable: true,
      encryptedStorePath: null,
      decryptionFailed: false,
    });
  });

  it("writes a provider API key to the account vault without waiting for it", async () => {
    const credentialStore = new MemoryCredentialStore();
    const vault = createVaultMock();
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, {
      credentialStore,
      getAccountVault: () => vault as never,
    });

    store.storeApiKey(" OpenAI ", " sk-account-key ");

    expect(store.getApiKey("openai")).toBe("sk-account-key");
    expect(vault.set).toHaveBeenCalledWith("all", "provider_api_key", "openai", "sk-account-key");
  });

  it("skips account-vault writes for device-only provider keys", async () => {
    const credentialStore = new MemoryCredentialStore();
    const vault = createVaultMock();
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, {
      credentialStore,
      getAccountVault: () => vault as never,
    });

    store.storeApiKey("cursor", "crsr-device-key", { deviceOnly: true });

    expect(store.getApiKey("cursor")).toBe("crsr-device-key");
    expect(vault.set).not.toHaveBeenCalled();
  });


  it("hydrates only provider keys missing from the local store", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const credentialStore = new MemoryCredentialStore();
    credentialStore.setSync("ai.api_key.index.v1", JSON.stringify(["openai"]));
    credentialStore.setSync("ai.api_key.openai.v1", "sk-local-key");
    const vault = createVaultMock();
    vault.list.mockResolvedValue({
      ok: true,
      value: [
        { scope: "all", kind: "provider_api_key", key: "anthropic", value: null, updatedAt: "now" },
        { scope: "all", kind: "provider_api_key", key: "openai", value: "sk-vault-stale", updatedAt: "now" },
      ],
    } as never);
    vault.get.mockResolvedValueOnce({ ok: true, value: "sk-vault-key" } as never);
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, {
      credentialStore,
      getAccountVault: () => vault as never,
      getAccountUserId: () => "account-a",
    });

    await store.hydrateApiKeysFromVault();

    expect(store.getApiKey("anthropic")).toBe("sk-vault-key");
    expect(store.getApiKeyProvenance("anthropic")).toEqual({
      source: "account",
      accountUserId: "account-a",
    });
    expect(store.getApiKey("openai")).toBe("sk-local-key");
    expect(vault.get).toHaveBeenCalledWith("all", "provider_api_key", "anthropic");
    expect(vault.set).not.toHaveBeenCalled();
  });

  it("returns and logs case-insensitive credential collisions without replacing the local key", async () => {
    const credentialStore = new MemoryCredentialStore();
    const vault = createVaultMock();
    const logger = { warn: vi.fn() };
    vault.list.mockResolvedValue({
      ok: true,
      value: [{ scope: "all", kind: "provider_api_key", key: "openai#work", value: "sk-vault", updatedAt: "now" }],
    } as never);
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, {
      credentialStore,
      getAccountVault: () => vault as never,
      getAccountUserId: () => "account-a",
      logger,
    });
    store.storeApiCredential({
      provider: "openai",
      credentialId: "Work",
      label: "Work",
      key: "sk-local",
      deviceOnly: true,
    });

    const result = await store.hydrateApiKeysFromVault();

    expect(result.collisions).toEqual([{
      provider: "openai",
      credentialId: "work",
      existingCredentialId: "Work",
      storageKey: "openai#work",
    }]);
    expect(store.getApiCredentialKey("openai", "Work")).toBe("sk-local");
    expect(logger.warn).toHaveBeenCalledWith("ai.api_key_vault_sync_failed", expect.objectContaining({
      operation: "hydrate",
      provider: "openai#work",
      error: "credential id collides case-insensitively with an existing local credential; skipped",
    }));
  });


  it("removes a provider API key from both local storage and the account vault", async () => {
    const credentialStore = new MemoryCredentialStore();
    const vault = createVaultMock();
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, {
      credentialStore,
      getAccountVault: () => vault as never,
    });
    store.storeApiKey("openai", "sk-account-key");
    vault.set.mockClear();

    store.deleteApiKey("openai");

    expect(store.getApiKey("openai")).toBeNull();
    expect(vault.remove).toHaveBeenCalledWith("all", "provider_api_key", "openai");
  });

  it("keeps local API-key operations synchronous and logs an unavailable vault failure", async () => {
    const credentialStore = new MemoryCredentialStore();
    const vault = createVaultMock();
    const logger = { warn: vi.fn() };
    vault.set.mockRejectedValueOnce(new Error("runtime unavailable"));
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, {
      credentialStore,
      getAccountVault: () => vault as never,
      logger,
    });

    expect(() => store.storeApiKey("openai", "sk-local-key")).not.toThrow();
    expect(store.getApiKey("openai")).toBe("sk-local-key");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledWith("ai.api_key_vault_sync_failed", expect.objectContaining({
      operation: "set",
      provider: "openai",
    }));

    const unavailable = await loadStoreModule();
    unavailable.initApiKeyStore(tempRoot, { credentialStore });
    await expect(unavailable.hydrateApiKeysFromVault()).resolves.toEqual({ collisions: [] });
  });
});

/**
 * The CTO voice key is not the project's. It pays for calls this MACHINE makes,
 * so it is stored in the machine ADE home and must be readable from any project
 * — and, just as importantly, a key sitting in one project's `.ade/secrets`
 * must NOT leak into it. These tests pin both directions of that boundary.
 */
describe("apiKeyStore machine scope", () => {
  let projectRoot: string;
  let machineHome: string;
  let keychain: Map<string, string>;

  const projectStoreFile = () => path.join(projectRoot, ".ade", "secrets", "api-keys.v1.bin");
  const machineStoreFile = () => path.join(machineHome, "secrets", "api-keys.v1.bin");

  beforeEach(() => {
    spawnSyncMock.mockReset();
    safeStorageState.available = false;
    safeStorageState.decrypted = "{}";
    safeStorageState.encrypted = Buffer.from("encrypted");
    keychain = new Map();
    installSecurityMock(keychain);

    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-api-key-project-"));
    machineHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-api-key-machine-"));
    process.env = {
      ...originalEnv,
      ADE_HOME: machineHome,
      // The three-tier read is covered by the suite above; here the Keychain
      // tier only adds `security` noise between the two directories under test.
      ADE_API_KEY_STORE_DISABLE_KEYCHAIN: "1",
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.CURSOR_API_KEY;
    setPlatform("darwin");
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(machineHome, { recursive: true, force: true });
    process.env = { ...originalEnv };
    setPlatform(originalPlatform);
    vi.resetModules();
  });

  it("writes the encrypted fallback to the machine home, never to the project", async () => {
    safeStorageState.available = true;
    const store = await loadStoreModule();
    store.initApiKeyStore(projectRoot);

    store.storeMachineApiKey("openai", " sk-machine-key ");

    expect(store.getMachineApiKey("openai")).toBe("sk-machine-key");
    expect(fs.existsSync(machineStoreFile())).toBe(true);
    expect(fs.existsSync(projectStoreFile())).toBe(false);
    // The project scope is untouched: nothing was written under `.ade/secrets`,
    // so a project-scoped read has nothing to find.
    expect(fs.existsSync(path.join(projectRoot, ".ade", "secrets"))).toBe(false);
  });

  it("survives switching projects, because it never belonged to one", async () => {
    safeStorageState.available = true;
    const store = await loadStoreModule();
    store.initApiKeyStore(projectRoot);
    store.storeMachineApiKey("openai", "sk-machine-key");

    // Re-reading the machine home is what proves the key outlives the project:
    // `initApiKeyStore` drops the cached machine view, so this answer comes off
    // disk rather than out of memory.
    safeStorageState.decrypted = JSON.stringify({ openai: "sk-machine-key" });
    const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), "ade-api-key-other-"));
    try {
      store.initApiKeyStore(otherProject);
      expect(store.getMachineApiKey("openai")).toBe("sk-machine-key");
      expect(fs.existsSync(path.join(otherProject, ".ade", "secrets", "api-keys.v1.bin"))).toBe(false);
    } finally {
      fs.rmSync(otherProject, { recursive: true, force: true });
    }
  });

  it("does not adopt a key that only exists in the project's .ade/secrets", async () => {
    // The project-scoped store holds an OpenAI key. The machine scope must not
    // see it, and must not migrate it into the shared credential store either —
    // that migration is exactly what makes a key follow a project.
    fs.mkdirSync(path.join(projectRoot, ".ade", "secrets"), { recursive: true });
    fs.writeFileSync(projectStoreFile(), Buffer.from("project-encrypted"));
    safeStorageState.available = true;
    safeStorageState.decrypted = JSON.stringify({ openai: "sk-project-key" });
    const credentialStore = new MemoryCredentialStore();
    const store = await loadStoreModule();
    store.initApiKeyStore(projectRoot, { credentialStore });

    expect(store.getMachineApiKey("openai")).toBeNull();
    expect(store.getMachineApiKeyStatus("openai")).toMatchObject({ configured: false, source: null });
    expect(credentialStore.values.has("ai.api_key.openai.v1")).toBe(false);

    // The project's own copy is genuinely readable, so the null above is a
    // boundary and not a broken fixture.
    expect(store.getApiKey("openai")).toBe("sk-project-key");
  });

  it("re-reads the machine store when another process writes it", async () => {
    // Three processes share ~/.ade/secrets: the desktop app, the `ade` CLI and
    // the project runtime. Before this, whichever of them read first cached the
    // store for its whole life, so a key stored by one was invisible to the
    // others — which is exactly how a key saved in Settings left the
    // runtime-hosted voice call still answering "no OpenAI key on this machine".
    safeStorageState.available = true;
    const store = await loadStoreModule();
    store.initApiKeyStore(projectRoot);

    expect(store.getMachineApiKey("openai")).toBeNull();

    // Another process writes the machine store. Different length as well as
    // different content, so the check does not depend on filesystem mtime
    // granularity.
    fs.mkdirSync(path.join(machineHome, "secrets"), { recursive: true });
    fs.writeFileSync(machineStoreFile(), Buffer.from("encrypted-by-another-process"));
    safeStorageState.decrypted = JSON.stringify({ openai: "sk-written-elsewhere" });

    // No re-init, no explicit invalidation: the read notices by itself.
    expect(store.getMachineApiKey("openai")).toBe("sk-written-elsewhere");
    expect(store.getMachineApiKeyStatus("openai")).toMatchObject({
      configured: true,
      source: "store",
    });
  });

  it("notices the machine store being deleted out from under it", async () => {
    // A missing file is a value too: the reverse direction has to work, or a
    // key revoked by the CLI stays usable in every process that cached it.
    safeStorageState.available = true;
    const store = await loadStoreModule();
    store.initApiKeyStore(projectRoot);
    store.storeMachineApiKey("openai", "sk-machine-key");
    expect(store.getMachineApiKey("openai")).toBe("sk-machine-key");

    fs.rmSync(machineStoreFile(), { force: true });
    safeStorageState.decrypted = "{}";

    expect(store.getMachineApiKey("openai")).toBeNull();
  });

  it("reports the environment variable as the last tier, and a stored key as replaceable", async () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    safeStorageState.available = true;
    const store = await loadStoreModule();
    store.initApiKeyStore(projectRoot);

    expect(store.getMachineApiKeyStatus("openai")).toEqual({
      provider: "openai",
      configured: true,
      source: "env",
      envVar: "OPENAI_API_KEY",
    });

    store.storeMachineApiKey("openai", "sk-machine-key");

    // A stored key wins over the environment, and only a stored key is one the
    // UI may offer to replace or delete.
    expect(store.getMachineApiKeyStatus("openai")).toMatchObject({ configured: true, source: "store" });
    expect(store.getMachineApiKey("openai")).toBe("sk-machine-key");
    expect(store.listMachineStoredProviders()).toEqual(["openai"]);

    store.deleteMachineApiKey("openai");

    expect(store.getMachineApiKeyStatus("openai")).toMatchObject({ configured: true, source: "env" });
    expect(store.getMachineApiKey("openai")).toBe("sk-from-env");
  });

  it("writes a machine key with no project open into the shared credential store", async () => {
    // A window with no project bound — remote-bound, or in-process mode — never
    // runs `initApiKeyStore`, so the machine scope used to find no credential
    // store at all: the write landed in an Electron-only safeStorage blob no
    // runtime can decrypt, and took the working Keychain copy down with it.
    process.env.ADE_API_KEY_STORE_FORCE_KEYCHAIN = "1";
    delete process.env.ADE_API_KEY_STORE_DISABLE_KEYCHAIN;
    keychain.set("openai", "sk-keychain-copy");
    safeStorageState.available = true;
    const secretsDir = path.join(machineHome, "secrets");
    const { EncryptedFileCredentialStore } = await import("../../../../../ade-cli/src/services/credentials/credentialStore");
    const credentialStore = new EncryptedFileCredentialStore({ secretsDir });
    const store = await loadStoreModule();

    // Registered at app start, with no project ever opened.
    store.initMachineApiKeyStore({ credentialStore });
    store.storeMachineApiKey("openai", " sk-machine-key ");

    expect(store.getMachineApiKey("openai")).toBe("sk-machine-key");
    expect(store.getMachineApiKeyStatus("openai")).toMatchObject({
      configured: true,
      source: "store",
    });
    // The shared file the brain and the CLI read, not the safeStorage fallback.
    expect(fs.existsSync(path.join(secretsDir, "credentials.json.enc"))).toBe(true);
    expect(fs.existsSync(machineStoreFile())).toBe(false);
    const persisted = fs.readFileSync(path.join(secretsDir, "credentials.json.enc"), "utf8");
    expect(persisted).not.toContain("sk-machine-key");
    // And the Keychain copy survives: a credential-store write has no business
    // deleting the tier it migrates from.
    expect(keychain.get("openai")).toBe("sk-keychain-copy");
    expect(securityCommandCalls("delete-generic-password")).toEqual([]);
  });

  it("leaves the project scope's own reads working after a machine write", async () => {
    // The two scopes share one machine-wide credential store, so a write
    // through either must not strand the other on a cached "no key here".
    const credentialStore = new MemoryCredentialStore();
    const store = await loadStoreModule();
    store.initApiKeyStore(projectRoot, { credentialStore });

    expect(store.getApiKey("openai")).toBeNull();
    store.storeMachineApiKey("openai", "sk-machine-key");

    expect(store.getApiKey("openai")).toBe("sk-machine-key");
    expect(store.getMachineApiKey("openai")).toBe("sk-machine-key");
    expect(fs.existsSync(projectStoreFile())).toBe(false);
  });
});
