import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ElectronSafeStorageCredentialStore,
  EncryptedFileCredentialStore,
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

    expect(await store.get("openai")).toBe("sk-test");
    expect(fs.readFileSync(path.join(tempDir, "credentials.safe.enc"), "utf8")).toContain("safe:");
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
});
