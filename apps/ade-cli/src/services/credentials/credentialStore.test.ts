import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ElectronSafeStorageCredentialStore,
  EncryptedFileCredentialStore,
  KeytarCredentialStore,
  createDefaultCredentialStore,
} from "./credentialStore";
import {
  readOrCreateWindowsDpapiMaterial,
  readOrCreateWindowsDpapiMaterialAsync,
} from "./windowsDpapiMaterial";

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-credentials-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("EncryptedFileCredentialStore", () => {
  it.runIf(process.platform === "win32")(
    "binds headless credential encryption to the current Windows account with DPAPI",
    async () => {
      const previousNodeEnv = process.env.NODE_ENV;
      const previousVitest = process.env.VITEST;
      delete process.env.NODE_ENV;
      delete process.env.VITEST;
      try {
        const syncDir = path.join(tempDir, "sync-dpapi");
        const syncMaterial = readOrCreateWindowsDpapiMaterial(syncDir);
        const protectedKeyPath = path.join(syncDir, ".credential-key.dpapi");
        const protectedKey = fs.readFileSync(protectedKeyPath, "utf8");

        expect(syncMaterial).toHaveLength(32);
        expect(protectedKey).toContain("ADE_WINDOWS_DPAPI_KEY_V1");
        expect(protectedKey).not.toContain(syncMaterial.toString("base64"));
        expect(readOrCreateWindowsDpapiMaterial(syncDir)).toEqual(syncMaterial);

        const store = new EncryptedFileCredentialStore({ secretsDir: syncDir });
        store.setSync("account.session.v1", "windows-account-session");
        const credentialsPath = path.join(syncDir, "credentials.json.enc");
        const machineKeyPath = path.join(syncDir, ".machine-key");
        expect(fs.readFileSync(credentialsPath, "utf8"))
          .not.toContain("windows-account-session");

        const explicitPathReader = new EncryptedFileCredentialStore({
          credentialsPath,
          machineKeyPath,
        });
        expect(explicitPathReader.getSync("account.session.v1"))
          .toBe("windows-account-session");
        await expect(explicitPathReader.get("account.session.v1"))
          .resolves.toBe("windows-account-session");

        const customCredentialDir = path.join(tempDir, "custom-credential-dir");
        const customKeyDir = path.join(tempDir, "custom-key-dir");
        const customMachineKeyPath = path.join(customKeyDir, ".machine-key");
        const customStore = new EncryptedFileCredentialStore({
          secretsDir: customCredentialDir,
          machineKeyPath: customMachineKeyPath,
        });
        customStore.setSync("account.session.v1", "custom-key-location");
        expect(fs.existsSync(path.join(customKeyDir, ".credential-key.dpapi"))).toBe(true);
        expect(fs.existsSync(path.join(customCredentialDir, ".credential-key.dpapi"))).toBe(false);
        expect(new EncryptedFileCredentialStore({
          credentialsPath: path.join(customCredentialDir, "credentials.json.enc"),
          machineKeyPath: customMachineKeyPath,
        }).getSync("account.session.v1")).toBe("custom-key-location");

        const asyncDir = path.join(tempDir, "async-dpapi");
        const asyncMaterial = await readOrCreateWindowsDpapiMaterialAsync(asyncDir);
        expect(asyncMaterial).toHaveLength(32);
        expect(fs.readFileSync(path.join(asyncDir, ".credential-key.dpapi"), "utf8"))
          .not.toContain(asyncMaterial.toString("base64"));
      } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
        if (previousVitest === undefined) delete process.env.VITEST;
        else process.env.VITEST = previousVitest;
      }
    },
    20_000,
  );

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

  it("notifies another service instance when the credential file changes", () => {
    const reader = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      credentialChangePollIntervalMs: null,
    });
    const writer = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    let changes = 0;
    const unsubscribe = reader.onDidChange(() => {
      changes += 1;
    });

    writer.setSync("account.session.v1", "session");
    reader.checkForChangesNow();

    expect(changes).toBe(1);
    reader.checkForChangesNow();
    expect(changes).toBe(1);
    unsubscribe();
  });

  it("isolates change-listener failures so sibling subscribers still run", () => {
    const reader = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      credentialChangePollIntervalMs: null,
    });
    const writer = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    const sibling = vi.fn();
    reader.onDidChange(() => {
      throw new Error("subscriber failed");
    });
    reader.onDidChange(sibling);

    writer.setSync("account.session.v1", "session");

    expect(() => reader.checkForChangesNow()).not.toThrow();
    expect(sibling).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === "win32")("creates the secrets directory and files with private permissions", async () => {
    const secretsDir = path.join(tempDir, "secrets");
    const store = new EncryptedFileCredentialStore({ secretsDir });

    store.setSync("agent.token", "secret");

    expect(fs.statSync(secretsDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(secretsDir, ".machine-key")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(secretsDir, "credentials.json.enc")).mode & 0o777).toBe(0o600);
  });

  it("fails closed and preserves ciphertext after the machine key is replaced", () => {
    const store = new EncryptedFileCredentialStore({ secretsDir: tempDir });

    store.setSync("agent.token", "secret");
    const credentialPath = path.join(tempDir, "credentials.json.enc");
    const ciphertext = fs.readFileSync(credentialPath, "utf8");
    fs.writeFileSync(path.join(tempDir, ".machine-key"), `${Buffer.alloc(32, 1).toString("base64")}\n`);

    expect(store.getSync("agent.token")).toBeNull();
    expect(store.getLastReadState()).toBe("unreadable");
    expect(() => store.setSync("agent.other", "next-secret")).toThrow();
    expect(fs.readFileSync(credentialPath, "utf8")).toBe(ciphertext);
  });

  it("preserves concurrent writes from separate processes on first run", async () => {
    const readyDir = path.join(tempDir, "ready");
    fs.mkdirSync(readyDir);
    const writerPath = path.join(tempDir, "credential-writer.mjs");
    const storeModuleUrl = pathToFileURL(path.resolve("src/services/credentials/credentialStore.ts")).href;
    fs.writeFileSync(
      writerPath,
      `
import fs from "node:fs";
import path from "node:path";
import { EncryptedFileCredentialStore } from ${JSON.stringify(storeModuleUrl)};

const [secretsDir, readyDir, key, value] = process.argv.slice(2);
const goPath = path.join(readyDir, "go");
fs.writeFileSync(path.join(readyDir, \`\${key}.ready\`), "ready");
const deadline = Date.now() + 5000;
while (!fs.existsSync(goPath)) {
  if (Date.now() > deadline) throw new Error("Timed out waiting for writer barrier.");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
new EncryptedFileCredentialStore({ secretsDir }).setSync(key, value);
`,
      "utf8",
    );
    const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
    const entries = Array.from({ length: 8 }, (_, index) => ({
      key: `agent.token.${index}`,
      value: `secret-${index}`,
    }));
    const children = entries.map(({ key, value }) => {
      const child = spawn(process.execPath, [tsxCli, writerPath, tempDir, readyDir, key, value], {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      return {
        key,
        done: new Promise<{ code: number | null; stderr: string }>((resolve) => {
          child.on("error", (error) => resolve({ code: null, stderr: String(error) }));
          child.on("close", (code) => resolve({ code, stderr }));
        }),
      };
    });

    const readyDeadline = Date.now() + 5000;
    while (entries.some(({ key }) => !fs.existsSync(path.join(readyDir, `${key}.ready`)))) {
      if (Date.now() > readyDeadline) throw new Error("Timed out waiting for credential writers to become ready.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fs.writeFileSync(path.join(readyDir, "go"), "go");

    const results = await Promise.all(children.map((child) => child.done));
    expect(
      results.map((result) => result.code),
      results.map((result) => result.stderr).filter(Boolean).join("\n"),
    ).toEqual(results.map(() => 0));

    const store = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    for (const { key, value } of entries) {
      expect(store.getSync(key)).toBe(value);
    }
  }, 10000);

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
    expect(unbound.getSync("linear.token.v1")).toBeNull();
  });

  it("uses the asynchronous key-material path for asynchronous reads", async () => {
    const osMaterial = Buffer.from("test-os-material");
    new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterialProvider: () => osMaterial,
    }).setSync("github.token.v1", "ghp_async_read");
    const syncProvider = vi.fn(() => {
      throw new Error("synchronous keychain access must not run");
    });
    const asyncProvider = vi.fn(async () => osMaterial);
    const reader = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterialProvider: syncProvider,
      keyMaterialProviderAsync: asyncProvider,
    });

    await expect(reader.get("github.token.v1")).resolves.toBe("ghp_async_read");
    expect(asyncProvider).toHaveBeenCalledTimes(1);
    expect(syncProvider).not.toHaveBeenCalled();
  });

  it("does not touch key material when an asynchronous credential store is empty", async () => {
    const syncProvider = vi.fn(() => {
      throw new Error("synchronous keychain access must not run");
    });
    const asyncProvider = vi.fn(async () => {
      throw new Error("asynchronous keychain access must not run");
    });
    const reader = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterialProvider: syncProvider,
      keyMaterialProviderAsync: asyncProvider,
    });

    await expect(reader.get("github.token.v1")).resolves.toBeNull();
    expect(asyncProvider).not.toHaveBeenCalled();
    expect(syncProvider).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tempDir, ".machine-key"))).toBe(false);
  });

  it.each(["{}", "null"])("fails closed on an existing invalid async credential store: %s", async (raw) => {
    const credentialPath = path.join(tempDir, "credentials.json.enc");
    fs.writeFileSync(credentialPath, raw, "utf8");
    const asyncProvider = vi.fn(async () => Buffer.from("unused"));
    const reader = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterialProviderAsync: asyncProvider,
    });

    await expect(reader.get("github.token.v1")).rejects.toThrow(
      "Unsupported ADE credential store format.",
    );
    expect(reader.getLastReadState()).toBe("unreadable");
    expect(asyncProvider).not.toHaveBeenCalled();
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
    expect(legacy.getSync("agent.token")).toBe("legacy_secret");

    upgraded.setSync("agent.token", "bound_secret");

    expect(upgraded.getSync("agent.token")).toBe("bound_secret");
    expect(legacy.getSync("agent.token")).toBeNull();
  });

  it("fails safe instead of wiping ciphertext when OS-bound key material rotates", () => {
    const written = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterialProvider: () => Buffer.from("os-material-A"),
    });
    written.setSync("agent.token", "secret");

    const cipherPath = path.join(tempDir, "credentials.json.enc");
    const before = fs.readFileSync(cipherPath, "utf8");

    // Rotated OS material: neither the newly-derived key nor the bare machine key
    // can decrypt ciphertext that was sealed with material A. The store must throw
    // (preserving the ciphertext) instead of silently rewriting an empty store.
    const rotated = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterialProvider: () => Buffer.from("os-material-B"),
    });
    expect(() => rotated.getSync("agent.token")).toThrow();
    expect(() => rotated.setSync("agent.token", "wiped")).toThrow();

    // Ciphertext file untouched: the original credential is recoverable with material A.
    expect(fs.readFileSync(cipherPath, "utf8")).toBe(before);
    const recovered = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterialProvider: () => Buffer.from("os-material-A"),
    });
    expect(recovered.getSync("agent.token")).toBe("secret");
  });
});

describe("ElectronSafeStorageCredentialStore", () => {
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`safe:${value}`, "utf8"),
    decryptString: (value: Buffer) => {
      const raw = value.toString("utf8");
      if (!raw.startsWith("safe:")) throw new Error("not a safeStorage payload");
      return raw.slice("safe:".length);
    },
  };

  it("delegates encryption to the injected safeStorage implementation", async () => {
    const store = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });

    await store.set("openai", "sk-test");

    const raw = fs.readFileSync(path.join(tempDir, "credentials.safe.enc"), "utf8");
    expect(await store.get("openai")).toBe("sk-test");
    expect(raw).toContain("safe:");
    expect(raw).toContain("ADE_SAFE_STORAGE_CREDENTIALS_V1");
  });

  it("migrates a legacy encrypted-file store to safeStorage and removes the sibling file store", () => {
    const legacyStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    legacyStore.setSync("linear.token.v1", "lin_secret");

    const store = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });

    expect(store.getSync("linear.token.v1")).toBe("lin_secret");
    expect(fs.readFileSync(path.join(tempDir, "credentials.safe.enc"), "utf8")).toContain("safe:");
    expect(fs.existsSync(path.join(tempDir, "credentials.json.enc"))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, ".machine-key"))).toBe(false);
  });

  it("migrates a shared-path safeStorage file to the dedicated safeStorage file", () => {
    const sharedPathStore = new ElectronSafeStorageCredentialStore({
      secretsDir: tempDir,
      credentialsPath: path.join(tempDir, "credentials.json.enc"),
      legacyStore: null,
      safeStorage,
    });
    sharedPathStore.setSync("github.token.v1", "ghp_shared");

    const dedicatedStore = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });

    expect(dedicatedStore.getSync("github.token.v1")).toBe("ghp_shared");
    expect(fs.readFileSync(path.join(tempDir, "credentials.safe.enc"), "utf8")).toContain("safe:");
    expect(fs.existsSync(path.join(tempDir, "credentials.json.enc"))).toBe(false);
  });

  it("keeps the safeStorage store separate from the headless fallback store", () => {
    const legacyStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    legacyStore.setSync("linear.token.v1", "lin_secret");

    const desktopStore = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
    expect(desktopStore.getSync("linear.token.v1")).toBe("lin_secret");

    const fallbackStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    fallbackStore.setSync("github.token.v1", "ghp_headless");

    expect(desktopStore.getSync("linear.token.v1")).toBe("lin_secret");
    expect(fallbackStore.getSync("github.token.v1")).toBe("ghp_headless");
    expect(fs.readFileSync(path.join(tempDir, "credentials.safe.enc"), "utf8")).toContain("safe:");
    expect(fs.readFileSync(path.join(tempDir, "credentials.json.enc"), "utf8")).not.toContain("safe:");
  });

  it("does not fall back to legacy AES when a safeStorage-marked file fails to decrypt", async () => {
    const legacyStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
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
