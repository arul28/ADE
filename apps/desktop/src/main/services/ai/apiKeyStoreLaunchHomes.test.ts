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
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function securityArg(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? "" : "";
}

function installSecurityMock(keychain: Map<string, string>): void {
  spawnSyncMock.mockImplementation((_command: string, rawArgs: string[]) => {
    const args = rawArgs.map(String);
    const command = args[0];
    const account = securityArg(args, "-a");
    if (command === "find-generic-password") {
      if (!keychain.has(account)) return { status: 44, stdout: "", stderr: "not found" };
      return { status: 0, stdout: `${keychain.get(account) ?? ""}\n`, stderr: "" };
    }
    if (command === "add-generic-password") {
      keychain.set(account, securityArg(args, "-w"));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "delete-generic-password") {
      if (!keychain.has(account)) return { status: 44, stdout: "", stderr: "not found" };
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

  async get(key: string): Promise<string | null> { return this.getSync(key); }
  async set(key: string, value: string): Promise<void> { this.setSync(key, value); }
  async delete(key: string): Promise<void> { this.deleteSync(key); }
  getSync(key: string): string | null { return this.values.get(key) ?? null; }
  setSync(key: string, value: string): void { this.values.set(key, value); }
  deleteSync(key: string): void { this.values.delete(key); }
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

describe("apiKeyStore credential launch homes", () => {
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
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-api-key-launch-homes-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    process.env = { ...originalEnv };
    setPlatform(originalPlatform);
    vi.resetModules();
  });

  it("rejects traversal credential ids and removes their ADE launch home", async () => {
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, { credentialStore: new MemoryCredentialStore() });

    store.storeApiCredential({ provider: "acme", credentialId: "work", label: "Acme", key: "sk-acme" });
    expect(store.listApiCredentials("acme")).toEqual([
      expect.objectContaining({ provider: "acme", credentialId: "work" }),
    ]);
    expect(() => store.storeApiCredential({ provider: "openai", credentialId: "../outside", label: "Unsafe", key: "sk-unsafe" })).toThrow(/Credential ids may contain only/);
    expect(() => store.storeApiCredential({ provider: "openai", credentialId: "..\\outside", label: "Unsafe", key: "sk-unsafe" })).toThrow(/Credential ids may contain only/);

    const launchHome = path.join(tempRoot, "provider-homes", "preset", "credential-openai-secondary");
    fs.mkdirSync(launchHome, { recursive: true });
    fs.writeFileSync(path.join(launchHome, "secret.json"), "raw key");
    const { removeCredentialLaunchHome } = await import("../chat/harnessPresetConfigHomes");
    removeCredentialLaunchHome("openai", "secondary", tempRoot);
    expect(fs.existsSync(launchHome)).toBe(false);
  });

  it("binds hydrated API keys to their account and purges only account-origin values", async () => {
    const credentialStore = new MemoryCredentialStore();
    const store = await loadStoreModule();
    let accountUserId: string | null = "account-a";
    store.initApiKeyStore(tempRoot, {
      credentialStore,
      getAccountUserId: () => accountUserId,
      launchHomeAdeDir: tempRoot,
    });
    store.storeApiKey("cursor", "device-key", { deviceOnly: true });
    store.storeApiKey("openai", "hydrated-key", { deviceOnly: true, source: "account", accountUserId: "account-a" });
    expect(store.getApiKeyProvenance("cursor")).toEqual({ source: "device", accountUserId: null });
    expect(store.getApiKeyProvenance("openai")).toEqual({ source: "account", accountUserId: "account-a" });
    const purgedHome = path.join(tempRoot, "provider-homes", "credential", "openai-default");
    fs.mkdirSync(purgedHome, { recursive: true });
    fs.writeFileSync(path.join(purgedHome, "opencode.json"), "raw key");
    accountUserId = null;
    store.purgeAccountApiKeys();
    expect(store.getApiKey("cursor")).toBe("device-key");
    expect(store.getApiKey("openai")).toBeNull();
    expect(fs.existsSync(purgedHome)).toBe(false);
  });

  it("mirrors and purges credentials with composite vault keys", async () => {
    const credentialStore = new MemoryCredentialStore();
    const vault = createVaultMock();
    let accountUserId: string | null = "account-a";
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot, { credentialStore, getAccountVault: () => vault as never, getAccountUserId: () => accountUserId, launchHomeAdeDir: tempRoot });
    store.storeApiKey("openai", "sk-default");
    store.storeApiCredential({ provider: "openai", credentialId: "secondary", label: "Secondary", key: "sk-secondary" });
    await vi.waitFor(() => expect(vault.set).toHaveBeenCalledWith("all", "provider_api_key", "openai", "sk-default"));
    await vi.waitFor(() => expect(vault.set).toHaveBeenCalledWith("all", "provider_api_key", "openai#secondary", "sk-secondary"));

    vault.list.mockResolvedValue({ ok: true, value: [{ scope: "all", kind: "provider_api_key", key: "openai#hydrated", value: null, updatedAt: "now" }] } as never);
    vault.get.mockResolvedValueOnce({ ok: true, value: "sk-hydrated" } as never);
    await store.hydrateApiKeysFromVault();
    expect(vault.get).toHaveBeenCalledWith("all", "provider_api_key", "openai#hydrated");
    expect(store.getApiCredentialKey("openai", "hydrated")).toBe("sk-hydrated");
    expect(credentialStore.values.get("ai.api_key.provenance.v1")).toContain("openai#hydrated");
    const purgedHome = path.join(tempRoot, "provider-homes", "credential", "openai-hydrated");
    fs.mkdirSync(purgedHome, { recursive: true });
    fs.writeFileSync(path.join(purgedHome, "settings.json"), "raw key");
    accountUserId = null;
    store.purgeAccountApiKeys();
    expect(store.getApiCredentialKey("openai", "hydrated")).toBeNull();
    expect(credentialStore.values.has("ai.api_key.openai#hydrated.v1")).toBe(false);
    expect(fs.existsSync(purgedHome)).toBe(false);
    const removedHome = path.join(tempRoot, "provider-homes", "credential", "openai-secondary");
    fs.mkdirSync(removedHome, { recursive: true });
    fs.writeFileSync(path.join(removedHome, "settings.json"), "raw key");
    store.removeApiCredential("openai", "secondary");
    expect(fs.existsSync(removedHome)).toBe(false);
    await vi.waitFor(() => expect(vault.remove).toHaveBeenCalledWith("all", "provider_api_key", "openai#secondary"));
  });
});
