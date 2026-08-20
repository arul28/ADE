import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ElectronSafeStorageCredentialStore,
  EncryptedFileCredentialStore,
  KeytarCredentialStore,
  CREDENTIAL_STORE_LOCK_TIMEOUT_MS,
  adoptFileBackedCredentials,
  createDefaultCredentialStore,
  createRoutedCredentialStore,
  inspectCredentialStoreHealth,
  isFileBackedCredentialKey,
  readCredentialStoreQuarantine,
} from "./credentialStore";
import { quarantineCredentialFile } from "./credentialStoreQuarantine";
import {
  ACCOUNT_SESSION_CREDENTIAL_KEY,
  ACCOUNT_SESSION_ROTATION_JOURNAL_KEY,
  DEFAULT_REFRESH_ROTATION_WAIT_MS,
} from "../account/accountAuthService";
import { BOOTSTRAP_TOKEN_KEY } from "../sync/brainProjectActionsSyncHandler";
import { GITHUB_APP_USER_TOKEN_KEY } from "../../../../desktop/src/main/services/github/githubAppUserAuthService";
import {
  createMacKeychainMaterialResolver,
  resolveMacKeychainMaterialOutcome,
  resolveOsBoundKeyMaterialBinding,
  type MacKeychainCommands,
} from "./osBoundKeyMaterial";
import {
  readOrCreateWindowsDpapiMaterial,
  readOrCreateWindowsDpapiMaterialAsync,
  resolveWindowsDpapiPowerShellPath,
} from "./windowsDpapiMaterial";

let tempDir = "";

/**
 * Writes the shape an ADE build BEFORE this fix left on disk: a credential
 * envelope sealed with the OS-bound key and no `binding` field.
 *
 * The store deliberately has no writer for that shape any more — sealing the
 * shared file `os` is the trapdoor these tests exist to keep shut — so the
 * legacy format is pinned here instead. The HKDF parameters are copied from
 * `deriveOsBoundCredentialKey`; that duplication IS the compatibility contract.
 */
function sealLegacyOsBoundStore(
  secretsDir: string,
  values: Record<string, string>,
  material: Buffer,
  options: { declareBinding?: boolean } = {},
): void {
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const machineKeyPath = path.join(secretsDir, ".machine-key");
  let machineKey: Buffer;
  if (fs.existsSync(machineKeyPath)) {
    machineKey = Buffer.from(fs.readFileSync(machineKeyPath, "utf8").trim(), "base64");
  } else {
    machineKey = crypto.randomBytes(32);
    fs.writeFileSync(machineKeyPath, `${machineKey.toString("base64")}\n`, { mode: 0o600 });
  }
  const key = Buffer.from(crypto.hkdfSync(
    "sha256",
    material,
    machineKey,
    Buffer.from("ade.credentials.file-store.v2"),
    32,
  ));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("ade.credentials.v1"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(values), "utf8"),
    cipher.final(),
  ]);
  fs.writeFileSync(
    path.join(secretsDir, "credentials.json.enc"),
    `${JSON.stringify({
      version: 1,
      alg: "aes-256-gcm",
      ...(options.declareBinding ? { binding: "os" } : {}),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function readQuarantineMarker(secretsDir: string): {
  file: string;
  reason: string;
  recoverable: boolean;
} {
  return JSON.parse(fs.readFileSync(
    path.join(secretsDir, "credentials.json.enc.quarantine.json"),
    "utf8",
  )) as { file: string; reason: string; recoverable: boolean };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-credentials-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("EncryptedFileCredentialStore", () => {
  it.runIf(process.platform === "win32")(
    "resolves Windows DPAPI PowerShell through kernel SystemRoot despite poisoned environment paths",
    () => {
      const previousSystemRoot = process.env.SystemRoot;
      const previousWinDir = process.env.windir;
      process.env.SystemRoot = path.join(tempDir, "attacker-system-root");
      process.env.windir = path.join(tempDir, "attacker-windir");
      try {
        const resolved = resolveWindowsDpapiPowerShellPath();
        expect(path.win32.isAbsolute(resolved)).toBe(true);
        expect(resolved.toLowerCase()).toMatch(
          /\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/,
        );
        expect(resolved.toLowerCase()).not.toContain(tempDir.toLowerCase());
      } finally {
        if (previousSystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = previousSystemRoot;
        if (previousWinDir === undefined) delete process.env.windir;
        else process.env.windir = previousWinDir;
      }
    },
  );

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

  it("quarantines rather than overwrites ciphertext after the machine key is replaced", () => {
    const store = new EncryptedFileCredentialStore({ secretsDir: tempDir });

    store.setSync("agent.token", "secret");
    const credentialPath = path.join(tempDir, "credentials.json.enc");
    const ciphertext = fs.readFileSync(credentialPath, "utf8");
    fs.writeFileSync(path.join(tempDir, ".machine-key"), `${Buffer.alloc(32, 1).toString("base64")}\n`);

    expect(store.getSync("agent.token")).toBeNull();
    expect(store.getLastReadState()).toBe("unreadable");

    // The write must still not destroy credentials it could not read — but it
    // must also not throw, because throwing here is what crash-looped a brain
    // whose first startup act is minting the sync bootstrap token.
    expect(() => store.setSync("agent.other", "next-secret")).not.toThrow();
    expect(store.getSync("agent.other")).toBe("next-secret");

    const marker = readQuarantineMarker(tempDir);
    expect(fs.readFileSync(path.join(tempDir, marker.file), "utf8")).toBe(ciphertext);
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

  it("seals the shared store so a co-owner without OS key material can read it", () => {
    // THE trapdoor. The desktop app has keychain material; the launchd brain
    // does not. Whatever the app writes, the brain must be able to open — and
    // the app must not "upgrade" what the brain wrote into something it cannot.
    const osMaterial = Buffer.from("test-os-material");
    const withMaterial = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => osMaterial },
    });
    const withoutMaterial = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => null },
    });

    withMaterial.setSync("linear.token.v1", "lin_secret");
    expect(withoutMaterial.getSync("linear.token.v1")).toBe("lin_secret");

    // ...and the reverse direction, including the read that used to re-seal.
    withoutMaterial.setSync("account.session.v1", "session-json");
    expect(withMaterial.getSync("account.session.v1")).toBe("session-json");
    expect(withoutMaterial.getSync("account.session.v1")).toBe("session-json");
    expect(withoutMaterial.getLastReadState()).toBe("available");

    const envelope = JSON.parse(
      fs.readFileSync(path.join(tempDir, "credentials.json.enc"), "utf8"),
    ) as { binding?: string; version: number };
    expect(envelope.binding).toBe("machine");
    // Still version 1: a build that predates the binding field has to keep
    // reading this file, or a downgrade repeats the incident.
    expect(envelope.version).toBe(1);
  });

  it("converges an os-sealed store from an older build to the machine key", () => {
    const osMaterial = Buffer.from("legacy-os-material");
    sealLegacyOsBoundStore(tempDir, { "account.session.v1": "session-json" }, osMaterial);

    const brain = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      // Declared, not inherited from the test host: this is a machine where a
      // PEER process holds keychain material, which is the whole scenario.
      keyMaterial: { read: () => null, peerMayHoldMaterial: true },
    });
    expect(brain.getSync("account.session.v1")).toBeNull();
    expect(brain.getLastReadFailureReason()).toBe("no_os_key_material");

    // The desktop app, which CAN open it, re-seals it to the shared binding on
    // a plain read. No user action, no sign-in.
    const desktop = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => osMaterial },
    });
    expect(desktop.getSync("account.session.v1")).toBe("session-json");

    expect(brain.getSync("account.session.v1")).toBe("session-json");
    expect(brain.getLastReadState()).toBe("available");
  });

  it("converges an os-sealed store to the machine key on the asynchronous read path", async () => {
    const osMaterial = Buffer.from("windows-async-account-bound-material");
    sealLegacyOsBoundStore(
      tempDir,
      { "account.session.v1": "legacy-async-windows-session" },
      osMaterial,
      { declareBinding: true },
    );
    const credentialsPath = path.join(tempDir, "credentials.json.enc");
    const legacyCiphertext = fs.readFileSync(credentialsPath, "utf8");

    const syncProvider = vi.fn((): Buffer | null => {
      throw new Error("async convergence must not use synchronous key access");
    });
    const converging = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: syncProvider, readAsync: async () => osMaterial },
    });
    await expect(converging.get("account.session.v1")).resolves.toBe("legacy-async-windows-session");
    expect(syncProvider).not.toHaveBeenCalled();
    // The rebind is deferred off the awaited read on purpose — it takes the file
    // lock with a synchronous spin, and blocking the event loop for that is not
    // something the caller asked for.
    expect(fs.readFileSync(credentialsPath, "utf8")).toBe(legacyCiphertext);
    converging.flushPendingRebindNow();
    expect(fs.readFileSync(credentialsPath, "utf8")).not.toBe(legacyCiphertext);

    expect(new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => null },
    }).getSync("account.session.v1")).toBe("legacy-async-windows-session");
  });

  it("uses the asynchronous key-material path for asynchronous reads", async () => {
    const osMaterial = Buffer.from("test-os-material");
    new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => osMaterial },
    }).setSync("github.token.v1", "ghp_async_read");
    const syncProvider = vi.fn(() => {
      throw new Error("synchronous keychain access must not run");
    });
    const asyncProvider = vi.fn(async () => osMaterial);
    const reader = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: syncProvider, readAsync: asyncProvider },
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
      keyMaterial: { read: syncProvider, readAsync: asyncProvider },
    });

    await expect(reader.get("github.token.v1")).resolves.toBeNull();
    expect(asyncProvider).not.toHaveBeenCalled();
    expect(syncProvider).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tempDir, ".machine-key"))).toBe(false);
  });

  it.each(["{}", "null"])(
    "reports an existing invalid async credential store as unreadable rather than throwing: %s",
    async (raw) => {
      const credentialPath = path.join(tempDir, "credentials.json.enc");
      fs.writeFileSync(credentialPath, raw, "utf8");
      const asyncProvider = vi.fn(async () => Buffer.from("unused"));
      const reader = new EncryptedFileCredentialStore({
        secretsDir: tempDir,
        keyMaterial: { read: () => null, readAsync: asyncProvider },
      });

      // A read reports; it does not throw. The brain's startup path reads before
      // it writes, and a throw here is an exit code under launchd.
      await expect(reader.get("github.token.v1")).resolves.toBeNull();
      expect(reader.getLastReadState()).toBe("unreadable");
      expect(reader.getLastReadFailureReason()).toBe("store_format");
      expect(asyncProvider).not.toHaveBeenCalled();
    },
  );

  it.each(["{}", "null"])(
    "quarantines rather than silently replacing an invalid credential file on write: %s",
    (raw) => {
      const credentialPath = path.join(tempDir, "credentials.json.enc");
      fs.writeFileSync(credentialPath, raw, "utf8");
      const store = new EncryptedFileCredentialStore({
        secretsDir: tempDir,
        keyMaterial: { read: () => null },
      });

      expect(store.getSync("github.token.v1")).toBeNull();
      expect(store.getLastReadFailureReason()).toBe("store_format");
      store.setSync("github.token.v1", "ghp_next");

      const marker = readQuarantineMarker(tempDir);
      expect(marker.reason).toBe("store_format");
      expect(marker.recoverable).toBe(false);
      expect(fs.readFileSync(path.join(tempDir, marker.file), "utf8")).toBe(raw);
      expect(store.getSync("github.token.v1")).toBe("ghp_next");
    },
  );

  it("leaves an already machine-sealed store byte-identical on read", () => {
    const store = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => null },
    });
    store.setSync("agent.token", "legacy_secret");
    const credentialPath = path.join(tempDir, "credentials.json.enc");
    const ciphertext = fs.readFileSync(credentialPath, "utf8");

    // The process WITH key material used to rewrite this file into a binding the
    // writer above could never open again. It must now leave it alone.
    const withMaterial = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => Buffer.from("test-os-material") },
    });
    expect(withMaterial.getSync("agent.token")).toBe("legacy_secret");
    expect(fs.readFileSync(credentialPath, "utf8")).toBe(ciphertext);
    expect(store.getSync("agent.token")).toBe("legacy_secret");
  });

  it("re-reads key material once and self-heals a decrypt failure caused by stale cached material", () => {
    const winner = Buffer.from("os-material-winner");
    sealLegacyOsBoundStore(tempDir, { "account.session.v1": "session-json" }, winner);

    // This store cached the secret it minted before the peer's item won the
    // keychain race, so its first decrypt attempt fails.
    let material = Buffer.from("os-material-loser");
    const provider = vi.fn(() => material);
    const invalidateKeyMaterial = vi.fn(() => {
      material = winner;
    });
    const store = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: provider, invalidate: invalidateKeyMaterial },
    });

    expect(store.getSync("account.session.v1")).toBe("session-json");
    expect(store.getLastReadState()).toBe("available");
    expect(store.getLastReadFailureReason()).toBeNull();
    expect(invalidateKeyMaterial).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("does not re-ask for key material on every read while it keeps failing", () => {
    sealLegacyOsBoundStore(tempDir, { "agent.token": "secret" }, Buffer.from("os-material-A"));

    let material = Buffer.from("os-material-B");
    const invalidateKeyMaterial = vi.fn(() => {
      // Every re-read returns a different-but-still-wrong secret, so the retry
      // is genuinely attempted and genuinely fails each time.
      material = Buffer.from(`os-material-B-${invalidateKeyMaterial.mock.calls.length}`);
    });
    const store = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => material, invalidate: invalidateKeyMaterial },
    });

    expect(store.getSync("agent.token")).toBeNull();
    expect(store.getSync("agent.token")).toBeNull();
    expect(store.getSync("agent.token")).toBeNull();
    expect(invalidateKeyMaterial).toHaveBeenCalledTimes(1);
    expect(store.getLastReadState()).toBe("unreadable");
    expect(store.getLastReadFailureReason()).toBe("decrypt_failure");
  });

  it("reports why a read was unreadable", () => {
    const credentialPath = path.join(tempDir, "credentials.json.enc");
    fs.writeFileSync(credentialPath, JSON.stringify({ not: "an envelope" }), "utf8");
    const store = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => null },
    });

    expect(store.getSync("agent.token")).toBeNull();
    expect(store.getLastReadState()).toBe("unreadable");
    expect(store.getLastReadFailureReason()).toBe("store_format");
  });

  it("preserves ciphertext when OS-bound key material rotates under an older store", () => {
    sealLegacyOsBoundStore(tempDir, { "agent.token": "secret" }, Buffer.from("os-material-A"));
    const cipherPath = path.join(tempDir, "credentials.json.enc");
    const before = fs.readFileSync(cipherPath, "utf8");

    // Rotated OS material: neither the newly-derived key nor the bare machine
    // key decrypts ciphertext sealed with material A. The store must preserve
    // that ciphertext rather than write an empty store over it — but it must
    // keep serving its caller, not throw.
    const rotated = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => Buffer.from("os-material-B") },
    });
    expect(rotated.getSync("agent.token")).toBeNull();
    rotated.setSync("agent.token", "written-after-quarantine");

    const marker = readQuarantineMarker(tempDir);
    expect(fs.readFileSync(path.join(tempDir, marker.file), "utf8")).toBe(before);
  });

  it("merges a quarantined store back in once a peer process can decrypt it", () => {
    // The full self-heal for a machine already in the broken state: the brain
    // (no OS material) quarantines the os-sealed store and boots signed out, and
    // the desktop app puts the session back without anyone signing in again.
    const osMaterial = Buffer.from("desktop-only-material");
    sealLegacyOsBoundStore(
      tempDir,
      { "account.session.v1": "session-json", "linear.token.v1": "lin_secret" },
      osMaterial,
    );

    const brain = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => null, peerMayHoldMaterial: true },
    });
    brain.setSync("sync.bootstrapToken.v1", "fresh-token");
    expect(brain.getSync("account.session.v1")).toBeNull();
    expect(readQuarantineMarker(tempDir).recoverable).toBe(true);

    const desktop = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => osMaterial },
    });
    expect(desktop.getSync("account.session.v1")).toBe("session-json");

    // Recovered into the live store, so the brain sees it too...
    expect(brain.getSync("account.session.v1")).toBe("session-json");
    expect(brain.getSync("linear.token.v1")).toBe("lin_secret");
    // ...without losing what the brain wrote after the quarantine...
    expect(brain.getSync("sync.bootstrapToken.v1")).toBe("fresh-token");
    // ...and the recovered copy is not left decryptable on disk.
    expect(fs.existsSync(path.join(tempDir, "credentials.json.enc.quarantine.json"))).toBe(false);
    expect(fs.readdirSync(tempDir).filter((entry) => entry.includes(".quarantined-"))).toEqual([]);
  });

  it("never resurrects a quarantined value the live store has already replaced", () => {
    const osMaterial = Buffer.from("desktop-only-material");
    sealLegacyOsBoundStore(tempDir, { "account.session.v1": "old-session" }, osMaterial);

    const brain = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => null, peerMayHoldMaterial: true },
    });
    brain.setSync("account.session.v1", "session-signed-in-again");

    const desktop = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => osMaterial },
    });
    expect(desktop.getSync("account.session.v1")).toBe("session-signed-in-again");
  });

  it("stops promising a repair once the process holding the key has tried and failed", () => {
    // The destroyed-keychain-item case: the store is os-sealed, the item is
    // gone, so NOTHING on this Mac opens it. Telling the user to open the app
    // is only right until the app has tried.
    sealLegacyOsBoundStore(tempDir, { "account.session.v1": "session-json" }, Buffer.from("gone"));
    new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => null, peerMayHoldMaterial: true },
    }).setSync("sync.bootstrapToken.v1", "fresh-token");
    expect(readQuarantineMarker(tempDir).recoverable).toBe(true);

    const desktop = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => Buffer.from("a-different-item") },
    });
    expect(desktop.getSync("account.session.v1")).toBeNull();

    const marker = readQuarantineMarker(tempDir);
    expect(marker.recoverable).toBe(false);
    // The ciphertext itself is kept for diagnostics rather than deleted.
    expect(fs.existsSync(path.join(tempDir, marker.file))).toBe(true);
  });

  it("quarantines by copying, leaving the original for the caller's atomic write", () => {
    // Windows cannot rename or delete a file while any handle to it is open, so
    // a peer process mid-read turns a rename into EPERM/EACCES/EBUSY — and this
    // path throwing is the crash loop quarantine exists to prevent. Copying
    // leaves the original for the ordinary atomic write to replace, which is an
    // operation every credential write already performs.
    const credentialsPath = path.join(tempDir, "credentials.json.enc");
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(credentialsPath, "ciphertext-that-cannot-be-read", "utf8");

    const record = quarantineCredentialFile({
      credentialsPath,
      reason: "no_os_key_material",
      recoverable: true,
    });

    expect(record?.recoverable).toBe(true);
    expect(fs.readFileSync(credentialsPath, "utf8")).toBe("ciphertext-that-cannot-be-read");
    expect(fs.readFileSync(path.join(tempDir, record!.file), "utf8"))
      .toBe("ciphertext-that-cannot-be-read");
    expect(readCredentialStoreQuarantine(credentialsPath)).toEqual(record);
    // Nothing to set aside is not a failure: a peer may have replaced the file
    // between the failed read and this call.
    fs.unlinkSync(credentialsPath);
    expect(quarantineCredentialFile({
      credentialsPath,
      reason: "decrypt_failure",
      recoverable: false,
    })).toBeNull();
  });

  it("quarantines an unreadable store exactly once, however the write ends", () => {
    const store = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    store.setSync("agent.token", "secret");
    fs.writeFileSync(path.join(tempDir, ".machine-key"), `${Buffer.alloc(32, 3).toString("base64")}\n`);

    // Neither of these reaches a write: delete finds no key, and the updater
    // declines. Both still have to leave the store in a readable state, or the
    // next call quarantines the same file again — one copy per attempt.
    store.deleteSync("agent.token");
    store.updateSync(() => false);
    store.setSync("agent.token", "after");

    const quarantined = fs.readdirSync(tempDir).filter((entry) => entry.includes(".quarantined-"));
    expect(quarantined).toHaveLength(1);
    expect(store.getSync("agent.token")).toBe("after");
  });

  it("classifies peer-recoverability from the injected source, not the host OS", () => {
    // CI runs on Linux, where no process can hold OS material — so reading this
    // predicate from `process.platform` at the point of use made the store's
    // classification depend on the machine the code happened to run on, and made
    // the recoverable path untestable anywhere but macOS/Windows.
    sealLegacyOsBoundStore(tempDir, { "agent.token": "secret" }, Buffer.from("peer-material"));
    const credentialsPath = path.join(tempDir, "credentials.json.enc");
    const machineKeyPath = path.join(tempDir, ".machine-key");

    expect(inspectCredentialStoreHealth({
      credentialsPath,
      machineKeyPath,
      keyMaterial: { read: () => null, peerMayHoldMaterial: true },
    }).reason).toBe("no_os_key_material");

    // Same bytes, same absent material — a platform where nothing can hold it.
    expect(inspectCredentialStoreHealth({
      credentialsPath,
      machineKeyPath,
      keyMaterial: { read: () => null, peerMayHoldMaterial: false },
    }).reason).toBe("decrypt_failure");
  });

  it("does not create key material while inspecting a store", () => {
    // The default reader MINTS on both platforms — a macOS keychain item, or a
    // DPAPI key file behind a 30s synchronous PowerShell protect. A diagnostic
    // that used it would create the state it was asked to report on.
    const reads: string[] = [];
    const health = inspectCredentialStoreHealth({
      credentialsPath: path.join(tempDir, "credentials.json.enc"),
      machineKeyPath: path.join(tempDir, ".machine-key"),
      keyMaterial: {
        read: (dir) => {
          reads.push(dir);
          return null;
        },
      },
    });

    expect(health.state).toBe("missing");
    expect(fs.existsSync(path.join(tempDir, ".machine-key"))).toBe(false);
    // A missing store never even asks for key material.
    expect(reads).toEqual([]);
  });

  it("survives a key-material read that throws, on both the sync and async paths", async () => {
    // Windows: every DPAPI failure — including a transient PowerShell cold-start
    // timeout — throws out of the material read. That exception used to travel
    // straight out of getSync, and on the brain's startup path an exception is a
    // process exit and a launchd/Task Scheduler restart loop.
    const failing = {
      read: (): Buffer | null => {
        throw new Error("Windows DPAPI credential protection timed out.");
      },
      readAsync: async (): Promise<Buffer | null> => {
        throw new Error("Windows DPAPI credential protection timed out.");
      },
    };
    const store = new EncryptedFileCredentialStore({ secretsDir: tempDir, keyMaterial: failing });

    expect(() => store.setSync("sync.bootstrapToken.v1", "token")).not.toThrow();
    expect(store.getSync("sync.bootstrapToken.v1")).toBe("token");
    await expect(store.get("sync.bootstrapToken.v1")).resolves.toBe("token");
  });

  it("repairSync converges and recovers on demand, and reports what it found", () => {
    const osMaterial = Buffer.from("desktop-only-material");
    sealLegacyOsBoundStore(tempDir, { "account.session.v1": "session-json" }, osMaterial);
    new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => null, peerMayHoldMaterial: true },
    }).setSync("sync.bootstrapToken.v1", "fresh-token");

    const desktop = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => osMaterial },
    });
    const repair = desktop.repairSync();

    expect(repair.state).toBe("available");
    expect(repair.reason).toBeNull();
    expect(repair.recoveredKeys).toBe(1);
    expect(repair.quarantine).toBeNull();
    expect(desktop.getSync("account.session.v1")).toBe("session-json");
  });

  it("keeps an unrecoverable quarantine for diagnostics and reports it", () => {
    const store = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    store.setSync("agent.token", "secret");
    fs.writeFileSync(path.join(tempDir, ".machine-key"), `${Buffer.alloc(32, 7).toString("base64")}\n`);
    store.setSync("agent.token", "after");

    const health = inspectCredentialStoreHealth({
      credentialsPath: path.join(tempDir, "credentials.json.enc"),
      machineKeyPath: path.join(tempDir, ".machine-key"),
      keyMaterial: { read: () => null },
    });
    expect(health.state).toBe("available");
    expect(health.sealedBinding).toBe("machine");
    expect(health.quarantine?.recoverable).toBe(false);
    expect(fs.existsSync(path.join(tempDir, health.quarantine!.file))).toBe(true);
  });

  it("inspects a store without creating a machine key", () => {
    const health = inspectCredentialStoreHealth({
      credentialsPath: path.join(tempDir, "credentials.json.enc"),
      machineKeyPath: path.join(tempDir, ".machine-key"),
      keyMaterial: { read: () => null },
    });

    expect(health.state).toBe("missing");
    expect(health.reason).toBeNull();
    expect(fs.existsSync(path.join(tempDir, ".machine-key"))).toBe(false);
  });

  it("reports an os-sealed store this process cannot open, without touching it", () => {
    sealLegacyOsBoundStore(tempDir, { "agent.token": "secret" }, Buffer.from("peer-material"));
    const credentialsPath = path.join(tempDir, "credentials.json.enc");
    const before = fs.readFileSync(credentialsPath, "utf8");

    const health = inspectCredentialStoreHealth({
      credentialsPath,
      machineKeyPath: path.join(tempDir, ".machine-key"),
      keyMaterial: { read: () => null, peerMayHoldMaterial: true },
    });

    expect(health.state).toBe("unreadable");
    expect(health.reason).toBe("no_os_key_material");
    expect(fs.readFileSync(credentialsPath, "utf8")).toBe(before);
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

  /** Writes credentials.json.enc as an Electron-only safeStorage file. */
  const writeSharedPathSafeStorageFile = (values: Record<string, string>): void => {
    fs.writeFileSync(
      path.join(tempDir, "credentials.json.enc"),
      Buffer.concat([
        Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n"),
        safeStorage.encryptString(JSON.stringify(values)),
      ]),
    );
  };

  it("delegates encryption to the injected safeStorage implementation", async () => {
    const store = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });

    await store.set("openai", "sk-test");

    const raw = fs.readFileSync(path.join(tempDir, "credentials.safe.enc"), "utf8");
    expect(await store.get("openai")).toBe("sk-test");
    expect(raw).toContain("safe:");
    expect(raw).toContain("ADE_SAFE_STORAGE_CREDENTIALS_V1");
  });

  it("leaves the GitHub App user token where the brain and the CLI read it", () => {
    // Two copies of this record means two processes refreshing one rotating
    // refresh token, and GitHub answers a reused refresh token by revoking the
    // credential.
    const brainWrite = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    brainWrite.setSync("github.appUserToken.v1", JSON.stringify({ accessToken: "ghu_brain" }));

    const desktopStore = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
    desktopStore.getSync("linear.token.v1");

    const brainRead = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    expect(brainRead.getSync("github.appUserToken.v1")).toContain("ghu_brain");
    const safeFile = fs.readFileSync(path.join(tempDir, "credentials.safe.enc"), "utf8");
    expect(safeFile).not.toContain("ghu_brain");
  });

  it("routes file-backed keys to the shared file and adopts ones stranded in safeStorage", () => {
    const fileStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    const primary = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
    // What an older build left behind: the App token sealed in the file only the
    // desktop app can open.
    fs.writeFileSync(
      path.join(tempDir, "credentials.safe.enc"),
      Buffer.concat([
        Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n"),
        safeStorage.encryptString(JSON.stringify({
          "github.appUserToken.v1": "stranded-app-token",
          "linear.token.v1": "lin_secret",
        })),
      ]),
    );

    const adoption = adoptFileBackedCredentials({ primary, fileStore, identity: tempDir });
    const routed = createRoutedCredentialStore({ primary, fileStore });

    expect(adoption.adopted).toContain("github.appUserToken.v1");
    expect(fileStore.getSync("github.appUserToken.v1")).toBe("stranded-app-token");
    expect(primary.getSync("github.appUserToken.v1")).toBeNull();
    expect(routed.getSync("github.appUserToken.v1")).toBe("stranded-app-token");
    // Everything else keeps going to the Electron-only store.
    expect(routed.getSync("linear.token.v1")).toBe("lin_secret");
    expect(fileStore.getSync("linear.token.v1")).toBeNull();

    // The read state answers about the file the read actually went to, so an
    // unreadable sibling cannot make a good credential look unreadable.
    routed.getSync("linear.token.v1");
    expect(routed.getLastReadState?.()).toBe("available");

    // A write through the routed store reaches the brain, and so does the
    // atomic single-key update the refresh ledger runs on.
    routed.setSync("github.appUserToken.v1", "renewed-app-token");
    routed.updateKeySync?.("github.appUserToken.v1", (current) => `${current}+ledger`);
    expect(new EncryptedFileCredentialStore({ secretsDir: tempDir })
      .getSync("github.appUserToken.v1")).toBe("renewed-app-token+ledger");
  });

  it("never overwrites the shared file's credential with a stale safeStorage copy", () => {
    const fileStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    const fresh = JSON.stringify({
      accessToken: "fresh-from-brain",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    fileStore.setSync("github.appUserToken.v1", fresh);
    const primary = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
    fs.writeFileSync(
      path.join(tempDir, "credentials.safe.enc"),
      Buffer.concat([
        Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n"),
        safeStorage.encryptString(JSON.stringify({
          "github.appUserToken.v1": JSON.stringify({
            accessToken: "stale-from-june",
            updatedAt: "2026-06-01T00:00:00.000Z",
          }),
        })),
      ]),
    );

    const adoption = adoptFileBackedCredentials({ primary, fileStore, identity: tempDir });

    expect(adoption.adopted).toEqual([]);
    expect(adoption.pruned).toContain("github.appUserToken.v1");
    expect(fileStore.getSync("github.appUserToken.v1")).toBe(fresh);
    expect(primary.getSync("github.appUserToken.v1")).toBeNull();
  });

  it("dates a record that says obtainedAt rather than updatedAt", () => {
    // The account session spells the same fact that way, and a record ADE
    // cannot date is a record it will not replace.
    const fileStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    fileStore.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, JSON.stringify({
      accessToken: "session-from-june",
      obtainedAt: "2026-06-01T00:00:00.000Z",
    }));
    const primary = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
    const stranded = JSON.stringify({
      accessToken: "session-from-august",
      obtainedAt: "2026-08-01T00:00:00.000Z",
    });
    fs.writeFileSync(
      path.join(tempDir, "credentials.safe.enc"),
      Buffer.concat([
        Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n"),
        safeStorage.encryptString(JSON.stringify({ [ACCOUNT_SESSION_CREDENTIAL_KEY]: stranded })),
      ]),
    );

    const adoption = adoptFileBackedCredentials({ primary, fileStore, identity: tempDir });

    expect(adoption.adopted).toContain(ACCOUNT_SESSION_CREDENTIAL_KEY);
    expect(fileStore.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBe(stranded);
  });

  // Two secrets, neither of which says when it was written. Keeping the shared
  // one is a guess, and deleting the other on that guess is unrecoverable — so
  // the stranded copy stays where it is.
  it("leaves an undatable stranded copy alone rather than destroying it", () => {
    const fileStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    fileStore.setSync("github.appUserToken.v1", "shared-copy-with-no-date");
    const primary = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
    fs.writeFileSync(
      path.join(tempDir, "credentials.safe.enc"),
      Buffer.concat([
        Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n"),
        safeStorage.encryptString(JSON.stringify({
          "github.appUserToken.v1": "stranded-copy-with-no-date",
        })),
      ]),
    );

    const adoption = adoptFileBackedCredentials({ primary, fileStore, identity: tempDir });

    expect(adoption.adopted).toEqual([]);
    expect(adoption.pruned).toEqual([]);
    expect(fileStore.getSync("github.appUserToken.v1")).toBe("shared-copy-with-no-date");
    expect(primary.getSync("github.appUserToken.v1")).toBe("stranded-copy-with-no-date");
  });

  it("adopts a stranded safeStorage copy that is newer than the shared one", () => {
    // The build that wrote the App token into the Electron-only store left the
    // ONLY current copy there. Keeping the older shared copy hands GitHub a
    // refresh token it has already rotated away, which kills the credential.
    const fileStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    fileStore.setSync(GITHUB_APP_USER_TOKEN_KEY, JSON.stringify({
      accessToken: "ghu_from_june",
      updatedAt: "2026-06-01T00:00:00.000Z",
    }));
    const primary = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
    const stranded = JSON.stringify({
      accessToken: "ghu_from_august",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    fs.writeFileSync(
      path.join(tempDir, "credentials.safe.enc"),
      Buffer.concat([
        Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n"),
        safeStorage.encryptString(JSON.stringify({ [GITHUB_APP_USER_TOKEN_KEY]: stranded })),
      ]),
    );

    const adoption = adoptFileBackedCredentials({ primary, fileStore, identity: tempDir });

    expect(adoption.adopted).toContain(GITHUB_APP_USER_TOKEN_KEY);
    expect(fileStore.getSync(GITHUB_APP_USER_TOKEN_KEY)).toBe(stranded);
    expect(primary.getSync(GITHUB_APP_USER_TOKEN_KEY)).toBeNull();
  });

  it("keeps the shared copy when the stranded safeStorage copy is older", () => {
    const fileStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    const shared = JSON.stringify({
      accessToken: "ghu_from_august",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    fileStore.setSync(GITHUB_APP_USER_TOKEN_KEY, shared);
    const primary = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
    fs.writeFileSync(
      path.join(tempDir, "credentials.safe.enc"),
      Buffer.concat([
        Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n"),
        safeStorage.encryptString(JSON.stringify({
          [GITHUB_APP_USER_TOKEN_KEY]: JSON.stringify({
            accessToken: "ghu_from_june",
            updatedAt: "2026-06-01T00:00:00.000Z",
          }),
        })),
      ]),
    );

    const adoption = adoptFileBackedCredentials({ primary, fileStore, identity: tempDir });

    expect(adoption.adopted).toEqual([]);
    expect(adoption.pruned).toContain(GITHUB_APP_USER_TOKEN_KEY);
    expect(fileStore.getSync(GITHUB_APP_USER_TOKEN_KEY)).toBe(shared);
    expect(primary.getSync(GITHUB_APP_USER_TOKEN_KEY)).toBeNull();
  });

  it("retries adoption in the same process after a pass that could not read the Electron store", () => {
    // Marking the directory adopted before the pass succeeds strands the
    // credential for the whole life of the app: nothing constructs the store
    // again with a fresh chance to read it.
    const fileStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    const stranded = JSON.stringify({
      accessToken: "ghu_stranded",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    fs.writeFileSync(
      path.join(tempDir, "credentials.safe.enc"),
      Buffer.concat([
        Buffer.from("ADE_SAFE_STORAGE_CREDENTIALS_V1\n"),
        safeStorage.encryptString(JSON.stringify({ [GITHUB_APP_USER_TOKEN_KEY]: stranded })),
      ]),
    );
    const locked = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
    vi.spyOn(locked, "getSync").mockImplementation(() => {
      throw new Error("safeStorage is locked");
    });

    const firstPass = adoptFileBackedCredentials({ primary: locked, fileStore, identity: tempDir });
    expect(firstPass.adopted).toEqual([]);

    const unlocked = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
    const secondPass = adoptFileBackedCredentials({ primary: unlocked, fileStore, identity: tempDir });

    expect(secondPass.adopted).toContain(GITHUB_APP_USER_TOKEN_KEY);
    expect(fileStore.getSync(GITHUB_APP_USER_TOKEN_KEY)).toBe(stranded);
  });

  it("leaves the brain-readable account session in the legacy file store", () => {
    // The ADE brain (com.ade.runtime) and the CLI cannot read the Electron-only
    // safeStorage file. Migrating the account session into it and deleting the
    // file store is what left a signed-in machine unpublishable.
    const legacyStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    legacyStore.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, "session-json");
    legacyStore.setSync("sync.bootstrapToken.v1", "bootstrap-token");
    legacyStore.setSync("linear.token.v1", "lin_secret");

    const store = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });

    expect(store.getSync("linear.token.v1")).toBe("lin_secret");
    expect(fs.existsSync(path.join(tempDir, "credentials.json.enc"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, ".machine-key"))).toBe(true);

    // The excluded keys stay readable through the file store the brain uses...
    const brainStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    expect(brainStore.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBe("session-json");
    expect(brainStore.getSync("sync.bootstrapToken.v1")).toBe("bootstrap-token");

    // ...and never reach the Electron-only file.
    const safeFile = fs.readFileSync(path.join(tempDir, "credentials.safe.enc"), "utf8");
    expect(safeFile).not.toContain("session-json");
    expect(safeFile).not.toContain("bootstrap-token");
  });

  it("prunes migrated duplicates out of the retained legacy file store", () => {
    // A retained file store used to keep a FULL copy of every migrated key. The
    // app then rotates the token through safeStorage while the brain and the
    // CLI keep serving the stale file copy, and revoked secrets stay at rest.
    const legacyStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    legacyStore.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, "session-json");
    legacyStore.setSync("linear.token.v1", "lin_secret");
    legacyStore.setSync("github.token.v1", "ghp_secret");

    const store = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });

    expect(store.getSync("linear.token.v1")).toBe("lin_secret");
    expect(store.getSync("github.token.v1")).toBe("ghp_secret");
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();

    // The legacy file keeps ONLY what it stays authoritative for.
    const brainStore = new EncryptedFileCredentialStore({ secretsDir: tempDir });
    expect(brainStore.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBe("session-json");
    expect(brainStore.getSync("linear.token.v1")).toBeNull();
    expect(brainStore.getSync("github.token.v1")).toBeNull();
    expect(fs.existsSync(path.join(tempDir, ".machine-key"))).toBe(true);

    // Both stores still serve their own keys after the prune.
    brainStore.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, "session-json-2");
    expect(store.getSync("linear.token.v1")).toBe("lin_secret");
    expect(brainStore.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBe("session-json-2");
  });

  it("aborts the migration instead of destroying an unreadable legacy store", () => {
    // The migration reads the legacy store WITHOUT allowing a rewrite, and that
    // read returns {} rather than throwing when nothing can decrypt it. Acting
    // on that empty view wrote an empty safeStorage file, saw zero retained
    // keys, and unlinked credentials.json.enc AND .machine-key — every
    // credential on the machine, gone.
    const legacyPath = path.join(tempDir, "credentials.json.enc");
    const machineKeyPath = path.join(tempDir, ".machine-key");
    const safePath = path.join(tempDir, "credentials.safe.enc");
    sealLegacyOsBoundStore(tempDir, { "linear.token.v1": "lin_secret" }, Buffer.from("os-material-A"));
    const ciphertextBefore = fs.readFileSync(legacyPath, "utf8");
    const machineKeyBefore = fs.readFileSync(machineKeyPath, "utf8");

    // This process cannot obtain the OS material the ciphertext was sealed with
    // (locked/denied keychain), so it falls back to the bare machine key, which
    // does not decrypt either — the exact shape that reads as an empty store.
    // `peerMayHoldMaterial` is declared rather than inherited from the test
    // host: no peer can open this one either, which is what makes it a plain
    // decrypt failure below on macOS and Linux alike.
    const undecryptableLegacyStore = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => null, peerMayHoldMaterial: false },
    });
    expect(undecryptableLegacyStore.readAllForMigration()).toEqual({});
    expect(undecryptableLegacyStore.getLastReadState()).toBe("unreadable");
    const store = new ElectronSafeStorageCredentialStore({
      secretsDir: tempDir,
      safeStorage,
      legacyStore: undecryptableLegacyStore,
    });

    expect(store.getSync("linear.token.v1")).toBeNull();
    // …and it says so. A `null` here is indistinguishable from "never stored",
    // which is how a corrupted store reached the UI as a fresh install.
    expect(store.getLastReadState()).toBe("unreadable");
    expect(store.getLastReadFailureReason()).toBe("decrypt_failure");

    // Nothing written, nothing deleted: the credentials stay recoverable.
    expect(fs.existsSync(safePath)).toBe(false);
    expect(fs.readFileSync(legacyPath, "utf8")).toBe(ciphertextBefore);
    expect(fs.readFileSync(machineKeyPath, "utf8")).toBe(machineKeyBefore);
    const recovered = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => Buffer.from("os-material-A") },
    });
    expect(recovered.getSync("linear.token.v1")).toBe("lin_secret");
  });

  it("keeps the legacy store's own reason for an unreadable migration source", () => {
    // The launchd-brain shape: the legacy file is sealed with OS material this
    // process cannot obtain, but a PEER process can. That is
    // `no_os_key_material`, which is recoverable — reporting it as
    // `decrypt_failure` puts the wrong repair in front of a user whose
    // credentials are all still there.
    sealLegacyOsBoundStore(tempDir, { "linear.token.v1": "lin_secret" }, Buffer.from("os-material-A"));
    const legacyStore = new EncryptedFileCredentialStore({
      secretsDir: tempDir,
      keyMaterial: { read: () => null, peerMayHoldMaterial: true },
    });
    expect(legacyStore.readAllForMigration()).toEqual({});
    expect(legacyStore.getLastReadFailureReason()).toBe("no_os_key_material");

    const store = new ElectronSafeStorageCredentialStore({
      secretsDir: tempDir,
      safeStorage,
      legacyStore,
    });

    expect(store.getSync("linear.token.v1")).toBeNull();
    expect(store.getLastReadState()).toBe("unreadable");
    expect(store.getLastReadFailureReason()).toBe("no_os_key_material");
  });

  it("still moves and removes a legacy file that is already safeStorage-encrypted", () => {
    // Nothing in an Electron-only file is brain-readable, so retaining it would
    // only leave an undecryptable file behind for the brain to trip over.
    // Written the way an older app version wrote it, before the file-backed
    // keys were excluded from safeStorage — today's write path refuses this.
    writeSharedPathSafeStorageFile({ [ACCOUNT_SESSION_CREDENTIAL_KEY]: "session-json" });

    const dedicatedStore = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });

    expect(dedicatedStore.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBe("session-json");
    expect(fs.existsSync(path.join(tempDir, "credentials.json.enc"))).toBe(false);
  });

  it("refuses to write a file-backed credential into the Electron-only file", () => {
    // The migration keeps these keys in credentials.json.enc because the brain
    // and the CLI cannot read safeStorage. A writer that puts one into the
    // Electron-only file signs the brain out of a signed-in machine, so the
    // write path must fail loudly instead of succeeding invisibly.
    const store = new ElectronSafeStorageCredentialStore({ secretsDir: tempDir, safeStorage });
    store.setSync("linear.token.v1", "lin_secret");

    expect(() => store.setSync(ACCOUNT_SESSION_CREDENTIAL_KEY, "session-json"))
      .toThrow(/file-backed/);
    expect(() => store.updateSync((values) => {
      values[BOOTSTRAP_TOKEN_KEY] = "bootstrap-token";
    })).toThrow(/file-backed/);

    const safeFile = fs.readFileSync(path.join(tempDir, "credentials.safe.enc"), "utf8");
    expect(safeFile).not.toContain("session-json");
    expect(safeFile).not.toContain("bootstrap-token");
    expect(store.getSync("linear.token.v1")).toBe("lin_secret");
    expect(store.getSync(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBeNull();
  });

  it("keeps the account-session key excluded from safeStorage migration", () => {
    expect(isFileBackedCredentialKey(ACCOUNT_SESSION_CREDENTIAL_KEY)).toBe(true);
    // The rotation journal is only meaningful next to the session it describes:
    // migrating it into the Electron-only file would hide an interrupted
    // desktop rotation from the brain and the CLI.
    expect(isFileBackedCredentialKey(ACCOUNT_SESSION_ROTATION_JOURNAL_KEY)).toBe(true);
    // Asserted against the real constant: renaming it in the sync handler must
    // fail here instead of silently moving the token into safeStorage.
    expect(isFileBackedCredentialKey(BOOTSTRAP_TOKEN_KEY)).toBe(true);
    // Same rationale, one incident later: two copies of the GitHub App token
    // means two processes refreshing one rotating refresh token.
    expect(isFileBackedCredentialKey(GITHUB_APP_USER_TOKEN_KEY)).toBe(true);
    expect(isFileBackedCredentialKey("linear.token.v1")).toBe(false);
  });

  it("out-waits its own lock timeout in the account rotation window", () => {
    // The credential store's lock timeout is the floor for any cross-process
    // wait layered on top of it: a shorter wait lets an impatient loser condemn
    // a peer that legitimately won and is still queued for the lock.
    expect(CREDENTIAL_STORE_LOCK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_REFRESH_ROTATION_WAIT_MS).toBeGreaterThan(CREDENTIAL_STORE_LOCK_TIMEOUT_MS);
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

describe("resolveOsBoundKeyMaterialBinding", () => {
  // The key-material contract is platform-sensitive, and the platform that is
  // NOT this machine is the one that regresses silently. Drive the decision
  // directly with injected platform/env instead of spawning `security` or
  // `powershell.exe`: every entry point (read, readAsync, invalidate,
  // expectsOsBoundKeyMaterial) dispatches on exactly this value.
  it.each([
    { platform: "win32", expected: "windows_dpapi" },
    { platform: "darwin", expected: "macos_keychain" },
    { platform: "linux", expected: "none" },
  ] as const)("binds $platform to $expected", ({ platform, expected }) => {
    expect(resolveOsBoundKeyMaterialBinding(platform, {})).toBe(expected);
  });

  it.each(["win32", "darwin"] as const)(
    "applies the env opt-out on %s, not just on macOS",
    (platform) => {
      // A test process must never reach the real keychain OR the real DPAPI
      // helper; the guard used to be spelled per-platform and drifted.
      expect(resolveOsBoundKeyMaterialBinding(platform, { VITEST: "true" })).toBe("disabled");
      expect(resolveOsBoundKeyMaterialBinding(platform, { NODE_ENV: "test" })).toBe("disabled");
      expect(resolveOsBoundKeyMaterialBinding(platform, {
        ADE_CREDENTIAL_STORE_DISABLE_OS_BINDING: "1",
      })).toBe("disabled");
    },
  );

  it.each(["win32", "darwin", "linux"] as const)(
    "lets an explicit passphrase override the OS binding on %s",
    (platform) => {
      expect(resolveOsBoundKeyMaterialBinding(platform, {
        ADE_CREDENTIAL_STORE_PASSPHRASE: "shared-secret",
        ADE_CREDENTIAL_STORE_DISABLE_OS_BINDING: "1",
      })).toBe("env_passphrase");
    },
  );
});

describe("resolveMacKeychainMaterialOutcome", () => {
  const secretFor = (value: string) => Buffer.alloc(32, value[0]).toString("base64");

  it("uses the existing keychain item without writing", () => {
    const existing = secretFor("existing");
    const commands: MacKeychainCommands = {
      find: vi.fn(() => ({ kind: "found" as const, value: existing })),
      add: vi.fn(() => "created" as const),
    };

    expect(resolveMacKeychainMaterialOutcome(commands).material?.toString("base64")).toBe(existing);
    expect(commands.add).not.toHaveBeenCalled();
  });

  it("adopts the winner when the item appears between find and add", () => {
    // Two first-run processes race. This one sees "not found", loses the add,
    // and MUST adopt the peer's secret instead of overwriting it.
    const winner = secretFor("winner");
    const find = vi.fn()
      .mockReturnValueOnce({ kind: "not_found" as const })
      .mockReturnValueOnce({ kind: "found" as const, value: winner });
    const add = vi.fn(() => "exists" as const);

    const material = resolveMacKeychainMaterialOutcome({ find, add }).material;

    expect(material?.toString("base64")).toBe(winner);
    expect(find).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("converges on one secret when two stores race for a fresh keychain", () => {
    // Shared keychain: `add` only succeeds for whoever gets there first.
    let item: string | null = null;
    const commandsFor = (): MacKeychainCommands => ({
      find: () => (item == null ? { kind: "not_found" } : { kind: "found", value: item }),
      add: (secret) => {
        if (item != null) return "exists";
        item = secret;
        return "created";
      },
    });

    const first = resolveMacKeychainMaterialOutcome(commandsFor()).material;
    const second = resolveMacKeychainMaterialOutcome(commandsFor()).material;

    expect(first).not.toBeNull();
    expect(second?.toString("base64")).toBe(first?.toString("base64"));
  });

  it("fails closed instead of creating a replacement when the keychain errors", () => {
    // Timeouts and locked keychains are NOT "the item is missing": minting a
    // replacement here is what clobbers the peer process's secret.
    const add = vi.fn(() => "created" as const);

    expect(resolveMacKeychainMaterialOutcome({ find: () => ({ kind: "error" }), add }).material).toBeNull();
    expect(add).not.toHaveBeenCalled();
  });

  it("returns null when the add fails and the item still cannot be read", () => {
    const find = vi.fn(() => ({ kind: "not_found" as const }));
    const add = vi.fn(() => "error" as const);

    expect(resolveMacKeychainMaterialOutcome({ find, add }).material).toBeNull();
    expect(find).toHaveBeenCalledTimes(2);
  });
});

describe("createMacKeychainMaterialResolver", () => {
  const material = Buffer.alloc(32, 7);

  it("caches the resolved material instead of re-asking the OS", async () => {
    const read = vi.fn(() => ({ material }));
    const resolver = createMacKeychainMaterialResolver({
      read,
      readAsync: async () => ({ material: null, reason: "unavailable" as const }),
    });

    expect(resolver.read()).toBe(material);
    expect(resolver.read()).toBe(material);
    expect(await resolver.readAsync()).toBe(material);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("still creates the keychain item after repeated read-only not_found misses", async () => {
    // The read-only path refreshes the miss timestamp on every failed read, and
    // the creating path is the only one that can mint the item. If a not_found
    // miss armed the creation backoff, first-run creation would be starved
    // forever on any machine whose brain polls the session faster than 30s.
    let now = 1_700_000_000_000;
    const read = vi.fn(() => ({ material }));
    const readAsync = vi.fn(async () => ({ material: null, reason: "not_found" as const }));
    const resolver = createMacKeychainMaterialResolver({
      read,
      readAsync,
      now: () => now,
      negativeCacheMs: 30_000,
    });

    expect(await resolver.readAsync()).toBeNull();
    now += 1_000;
    expect(await resolver.readAsync()).toBeNull();
    now += 1_000;
    expect(await resolver.readAsync()).toBeNull();

    expect(resolver.read()).toBe(material);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("suppresses creation while the keychain itself is unavailable", () => {
    let now = 1_700_000_000_000;
    const read = vi.fn(() => ({ material: null, reason: "unavailable" as const }));
    const resolver = createMacKeychainMaterialResolver({
      read,
      readAsync: async () => ({ material: null, reason: "unavailable" as const }),
      now: () => now,
      negativeCacheMs: 30_000,
    });

    expect(resolver.read()).toBeNull();
    now += 10_000;
    expect(resolver.read()).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);

    // Once the window elapses the wedged keychain is worth one more attempt.
    now += 31_000;
    expect(resolver.read()).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("re-reads the OS after an invalidation even inside the backoff window", () => {
    let now = 1_700_000_000_000;
    let current: Buffer | null = null;
    const read = vi.fn(() => (current
      ? { material: current }
      : { material: null, reason: "unavailable" as const }));
    const resolver = createMacKeychainMaterialResolver({
      read,
      readAsync: async () => ({ material: null, reason: "unavailable" as const }),
      now: () => now,
      negativeCacheMs: 30_000,
    });

    expect(resolver.read()).toBeNull();
    current = material;
    now += 1_000;
    expect(resolver.read()).toBeNull();

    resolver.invalidate();
    expect(resolver.read()).toBe(material);
  });

  it("coalesces concurrent read-only resolutions into one OS call", async () => {
    const readAsync = vi.fn(async () => ({ material }));
    const resolver = createMacKeychainMaterialResolver({
      read: () => ({ material: null, reason: "unavailable" as const }),
      readAsync,
    });

    const [first, second] = await Promise.all([resolver.readAsync(), resolver.readAsync()]);

    expect(first).toBe(material);
    expect(second).toBe(material);
    expect(readAsync).toHaveBeenCalledTimes(1);
  });
});
