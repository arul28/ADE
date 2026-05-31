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

  it("prefers an existing Keychain value over an older encrypted blob during migration", async () => {
    keychain.set("cursor", "crsr_current_key");
    const secretsDir = path.join(tempRoot, ".ade", "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, "api-keys.v1.bin"), Buffer.from("old-encrypted"));
    safeStorageState.available = true;
    safeStorageState.decrypted = JSON.stringify({ cursor: "crsr_stale_key" });

    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot);

    expect(store.getApiKey("cursor")).toBe("crsr_current_key");
    expect(keychain.get("cursor")).toBe("crsr_current_key");
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
});
