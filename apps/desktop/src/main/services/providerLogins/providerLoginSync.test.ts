import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAccountVaultStore, type AccountVaultRelay } from "../../../../../ade-cli/src/services/account/accountVaultStore";
import { createProviderLoginSync } from "./providerLoginSync";

/**
 * The capture side must never put a login into the account that the CLI had
 * not finished writing: a half file, a file that moved under the read, or one
 * file of a pair without its partner. Any of those, applied on a cloud
 * computer, is a broken sign-in there. No screen shows this race, so the test
 * is the only check (P5 step 1, T2).
 *
 * Real files, the real vault store; only the relay (network) is faked.
 */

const USER = "user_capture";

describe("provider login capture: stable reads", () => {
  let root: string;
  let home: string;
  let adeDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-login-capture-"));
    home = path.join(root, "home");
    adeDir = path.join(root, "ade");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(adeDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeFile(rel: string, data: string | Buffer, ageMs: number): string {
    const abs = path.join(home, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    const seconds = (Date.now() - ageMs) / 1000;
    fs.utimesSync(abs, seconds, seconds);
    return abs;
  }

  async function makeSync() {
    const relay = {
      getAccountVault: vi.fn(async () => ({ items: [], cursor: null, truncated: false })),
      putAccountVault: vi.fn(async (items: unknown[]) => ({ updatedAt: new Date().toISOString(), results: items.map(() => ({ status: "written" })) })),
      deleteAccountVaultItem: vi.fn(async () => true),
    };
    const vault = createAccountVaultStore({
      adeDir,
      relay: relay as unknown as AccountVaultRelay,
      getAccountUserId: () => USER,
      getDeviceId: () => "device-a",
    });
    await vault.sync();
    const env: NodeJS.ProcessEnv = { HOME: home };
    const sync = createProviderLoginSync({
      adeDir,
      staticOff: null,
      vault: () => vault,
      settings: () => ({ get: () => undefined }),
      accountUserId: () => USER,
      machine: () => ({ machineKey: "machine-a", deviceId: "device-a", label: "test", platform: "linux" }),
      cloudAccess: async () => "ready",
      cloudComputer: false,
      logger: { info: () => {}, warn: () => {} },
      env,
      homeDir: home,
      platform: "linux",
    });
    /** The files of the one sign-in of `provider` in the account, decoded; null when there is none. */
    const carried = (provider: string): Record<string, string> | null => {
      const row = vault.list("all").find((entry) => entry.kind === "provider_login" && entry.key.startsWith(`${provider}/`) && !entry.deleted);
      if (!row) return null;
      const payload = JSON.parse(vault.get("all", "provider_login", row.key)!) as { files: Array<{ rel: string; enc: string; data: string }> };
      return Object.fromEntries(payload.files.map((file) => [file.rel, file.enc === "base64" ? Buffer.from(file.data, "base64").toString("hex") : file.data]));
    };
    return { sync, carried };
  }

  const grokLogin = (key: string) => JSON.stringify({ "https://auth.x.ai": { key, expires_at: "2099-01-01T00:00:00.000Z", email: "a@example.test" } });

  it("carries a login only once the CLI has finished writing it", async () => {
    const { sync, carried } = await makeSync();
    const finished = grokLogin("key-final");

    // Mid-write: half the file, written just now.
    writeFile(".grok/auth.json", finished.slice(0, 20), 0);
    await sync.pass();
    expect(carried("grok")).toBeNull();

    // A writer that stalled for seconds on a half file: old enough, but not a login.
    writeFile(".grok/auth.json", finished.slice(0, 20), 10_000);
    await sync.pass();
    expect(carried("grok")).toBeNull();

    // The file moves under the read: the pass must not carry what it read.
    const abs = writeFile(".grok/auth.json", grokLogin("key-before"), 10_000);
    const readFile = fs.promises.readFile.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "readFile").mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
      const bytes = await readFile(target as string, ...(rest as []));
      if (String(target) === abs) fs.writeFileSync(abs, finished);
      return bytes;
    }) as typeof fs.promises.readFile);
    await sync.pass();
    spy.mockRestore();
    expect(carried("grok")).toBeNull();

    // Finished and settled: the account holds exactly the finished file.
    const seconds = (Date.now() - 10_000) / 1000;
    fs.utimesSync(abs, seconds, seconds);
    await sync.pass();
    expect(carried("grok")).toEqual({ "auth.json": finished });
  });

  it("carries a two-file login as a matching pair, never one new file with one old", async () => {
    const { sync, carried } = await makeSync();
    const sealedA = crypto.randomBytes(64);
    writeFile(".factory/auth.v2.file", sealedA, 10_000);
    writeFile(".factory/auth.v2.key", "key-a", 10_000);
    await sync.pass();
    expect(carried("droid")).toEqual({ "auth.v2.file": sealedA.toString("hex"), "auth.v2.key": "key-a" });

    // A new sign-in rewrites both files; the key lands first, the sealed file is still being written.
    const sealedB = crypto.randomBytes(64);
    writeFile(".factory/auth.v2.key", "key-b", 10_000);
    writeFile(".factory/auth.v2.file", sealedB, 0);
    await sync.pass();
    expect(carried("droid")).toEqual({ "auth.v2.file": sealedA.toString("hex"), "auth.v2.key": "key-a" });

    const seconds = (Date.now() - 10_000) / 1000;
    fs.utimesSync(path.join(home, ".factory/auth.v2.file"), seconds, seconds);
    await sync.pass();
    expect(carried("droid")).toEqual({ "auth.v2.file": sealedB.toString("hex"), "auth.v2.key": "key-b" });
  });
});
