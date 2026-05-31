import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ElectronSafeStorageCredentialStore,
  EncryptedFileCredentialStore,
  KeytarCredentialStore,
  createDefaultCredentialStore,
} from "./credentialStore";

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-credentials-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("EncryptedFileCredentialStore", () => {
  it("persists credentials encrypted on disk", async () => {
    const store = new EncryptedFileCredentialStore({ secretsDir: tempDir });

    await store.set("linear.token.v1", "lin_secret");

    expect(await store.get("linear.token.v1")).toBe("lin_secret");
    expect(fs.readFileSync(path.join(tempDir, "credentials.json.enc"), "utf8")).not.toContain("lin_secret");

    const reloaded = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    expect(reloaded.getSync("linear.token.v1")).toBe("lin_secret");
  });

  it("deletes credentials without removing the machine key", async () => {
    const store = new EncryptedFileCredentialStore({ secretsDir: tempDir });

    await store.set("agent.token", "secret");
    await store.delete("agent.token");

    expect(await store.get("agent.token")).toBeNull();
    expect(fs.existsSync(path.join(tempDir, ".machine-key"))).toBe(true);
  });

  it("derives file encryption from OS-bound key material when available", async () => {
    const osMaterial = Buffer.from("test-os-material");
    const store = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterialProvider: () => osMaterial,
    });

    store.setSync("linear.token.v1", "lin_secret");

    const reloaded = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterialProvider: () => osMaterial,
    });
    expect(reloaded.getSync("linear.token.v1")).toBe("lin_secret");

    const unbound = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterialProvider: () => null,
    });
    expect(() => unbound.getSync("linear.token.v1")).toThrow();
  });

  it("can read legacy machine-key ciphertext before rewriting with OS-bound key material", async () => {
    const legacy = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterialProvider: () => null,
    });
    legacy.setSync("agent.token", "legacy_secret");

    const upgraded = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterialProvider: () => Buffer.from("test-os-material"),
    });
    expect(upgraded.getSync("agent.token")).toBe("legacy_secret");
    expect(() => legacy.getSync("agent.token")).toThrow();

    upgraded.setSync("agent.token", "bound_secret");

    expect(upgraded.getSync("agent.token")).toBe("bound_secret");
  });
});

describe("ElectronSafeStorageCredentialStore", () => {
  it("delegates encryption to the injected safeStorage implementation", async () => {
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`enc:${value}`, "utf8"),
      decryptString: (value: Buffer) => value.toString("utf8").replace(/^enc:/, ""),
    };
    const store = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });

    await store.set("openai", "sk-test");

    expect(await store.get("openai")).toBe("sk-test");
    expect(fs.readFileSync(path.join(tempDir, "credentials.json.enc"), "utf8")).toContain("enc:");
    expect(fs.readFileSync(path.join(tempDir, "credentials.json.enc"), "utf8")).toContain("ADE_SAFE_STORAGE_CREDENTIALS_V1");
  });

  it("reads legacy file-store credentials before rewriting with safeStorage", async () => {
    const legacyStore = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterialProvider: () => null,
    });
    legacyStore.setSync("github.token.v1", "ghp_legacy");
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`safe:${value}`, "utf8"),
      decryptString: (value: Buffer) => {
        const raw = value.toString("utf8");
        if (!raw.startsWith("safe:")) throw new Error("not safeStorage ciphertext");
        return raw.slice("safe:".length);
      },
    };
    const store = new ElectronSafeStorageCredentialStore({
      secretsDir: tempDir,
      safeStorage,
      legacyStore,
    });

    expect(store.getSync("github.token.v1")).toBe("ghp_legacy");
    expect(fs.readFileSync(path.join(tempDir, "credentials.json.enc"), "utf8")).toContain("safe:");

    store.setSync("github.token.v1", "ghp_safe");

    expect(fs.readFileSync(path.join(tempDir, "credentials.json.enc"), "utf8")).toContain("safe:");
    expect(store.getSync("github.token.v1")).toBe("ghp_safe");
    expect(() => legacyStore.getSync("github.token.v1")).toThrow();
  });

  it("does not fall back to legacy AES when a safeStorage-marked file fails to decrypt", async () => {
    const legacyStore = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterialProvider: () => null,
    });
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`safe:${value}`, "utf8"),
      decryptString: (value: Buffer) => {
        const raw = value.toString("utf8");
        if (!raw.startsWith("safe:")) throw new Error("safeStorage decrypt failed");
        return raw.slice("safe:".length);
      },
    };
    const store = new ElectronSafeStorageCredentialStore({
      secretsDir: tempDir,
      safeStorage,
      legacyStore,
    });
    store.setSync("github.token.v1", "ghp_safe");

    const failingStore = new ElectronSafeStorageCredentialStore({
      secretsDir: tempDir,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: safeStorage.encryptString,
        decryptString: () => {
          throw new Error("safeStorage decrypt failed");
        },
      },
      legacyStore,
    });

    expect(() => failingStore.getSync("github.token.v1")).toThrow("safeStorage decrypt failed");
  });
});

describe("KeytarCredentialStore", () => {
  it("uses keytar account names without touching the filesystem", async () => {
    const values = new Map<string, string>();
    const store = new KeytarCredentialStore({
      keytar: {
        async getPassword(service, account) {
          return values.get(`${service}:${account}`) ?? null;
        },
        async setPassword(service, account, password) {
          values.set(`${service}:${account}`, password);
        },
        async deletePassword(service, account) {
          return values.delete(`${service}:${account}`);
        },
      },
      service: "test.service",
    });

    await store.set("cursor", "cur_secret");
    expect(await store.get("cursor")).toBe("cur_secret");
    await store.delete("cursor");
    expect(await store.get("cursor")).toBeNull();
  });
});

describe("createDefaultCredentialStore", () => {
  it("falls back to encrypted-file storage when keytar is disabled", async () => {
    const store = await createDefaultCredentialStore({
      env: { ADE_CREDENTIAL_STORE_DISABLE_KEYTAR: "1" } as NodeJS.ProcessEnv,
      secretsDir: tempDir,
    });

    await store.set("codex", "token");

    expect(await store.get("codex")).toBe("token");
    expect(fs.existsSync(path.join(tempDir, "credentials.json.enc"))).toBe(true);
  });
});
