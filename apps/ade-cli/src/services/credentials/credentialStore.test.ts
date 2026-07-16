import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

  it("notifies another service instance when the credential file changes", async () => {
    const reader = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    const writer = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    let unsubscribe = () => {};
    const changed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for credential change.")), 1_000);
      unsubscribe = reader.onDidChange(() => {
        clearTimeout(timeout);
        resolve();
      });
    });

    writer.setSync("account.session.v1", "session");
    await changed;
    unsubscribe();
  });

  it("creates the secrets directory and files with private permissions", async () => {
    if (process.platform === "win32") return;
    const secretsDir = path.join(tempDir, "secrets");
    const store = new EncryptedFileCredentialStore({ secretsDir });

    store.setSync("agent.token", "secret");

    expect(fs.statSync(secretsDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(secretsDir, ".machine-key")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(secretsDir, "credentials.json.enc")).mode & 0o777).toBe(0o600);
  });

  it("recovers from a replaced first-run machine key by treating the encrypted map as empty", () => {
    const store = new EncryptedFileCredentialStore({ secretsDir: tempDir });

    store.setSync("agent.token", "secret");
    fs.writeFileSync(path.join(tempDir, ".machine-key"), `${Buffer.alloc(32, 1).toString("base64")}\n`);

    expect(store.getSync("agent.token")).toBeNull();
    expect(store.getLastReadState()).toBe("unreadable");
    store.setSync("agent.other", "next-secret");
    expect(store.getSync("agent.other")).toBe("next-secret");
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
