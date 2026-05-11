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
