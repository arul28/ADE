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

  it("stores Cursor keys in macOS Keychain without creating a safeStorage blob", async () => {
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot);

    store.storeApiKey("cursor", " crsr_test_key ");

    expect(store.getApiKey("cursor")).toBe("crsr_test_key");
    expect(store.listStoredProviders()).toContain("cursor");
    expect(keychain.get("cursor")).toBe("crsr_test_key");
    expect(keychain.get("__ade_provider_index__")).toContain("cursor");
    expect(fs.existsSync(path.join(tempRoot, ".ade", "secrets", "api-keys.v1.bin"))).toBe(false);
  });

  it("keeps a stored Keychain key usable when the provider index write fails", async () => {
    installSecurityMock(keychain, { failProviderIndexWrites: true });
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot);

    store.storeApiKey("cursor", "crsr_test_key");

    expect(store.getApiKey("cursor")).toBe("crsr_test_key");
    expect(store.listStoredProviders()).toContain("cursor");
    expect(keychain.get("cursor")).toBe("crsr_test_key");
    expect(keychain.has("__ade_provider_index__")).toBe(false);
    expect(store.getApiKeyStoreStatus().macosKeychainError).toContain("provider index write failed");
  });

  it("removes a deleted Keychain key from memory when the provider index write fails", async () => {
    keychain.set("__ade_provider_index__", JSON.stringify(["cursor"]));
    keychain.set("cursor", "crsr_test_key");
    installSecurityMock(keychain, { failProviderIndexWrites: true });
    const store = await loadStoreModule();
    store.initApiKeyStore(tempRoot);

    expect(store.getApiKey("cursor")).toBe("crsr_test_key");

    store.deleteApiKey("cursor");

    expect(store.getApiKey("cursor")).toBeNull();
    expect(store.listStoredProviders()).not.toContain("cursor");
    expect(keychain.has("cursor")).toBe(false);
    expect(keychain.get("__ade_provider_index__")).toContain("cursor");
    expect(store.getApiKeyStoreStatus().macosKeychainError).toContain("provider index write failed");
  });

  it("migrates a decryptable legacy safeStorage blob into macOS Keychain", async () => {
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
    expect(keychain.get("cursor")).toBe("crsr_old_key");
    expect(keychain.get("openai")).toBe("openai_old_key");
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
      secureStorageAvailable: true,
      macosKeychainAvailable: true,
      decryptionFailed: true,
    });
  });
});
