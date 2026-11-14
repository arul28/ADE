import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncryptedFileCredentialStore, type CredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { createPasswordService, type PasswordsRelay } from "../../../../../ade-cli/src/services/passwords/passwordService";
import type { PasswordRelayItem, PasswordRelayWrite } from "../../../../../ade-cli/src/services/push/pushRelayClient";
import type { AccountVaultItem } from "../../../shared/types/accountVault";
import { formatProjectSecretEnv, parseProjectSecretEnv } from "./projectSecretEnv";
import { createProjectSecretService, type LegacySecretVault } from "./projectSecretService";
import { createSecretTempFileStore } from "./secretTempFiles";
import { runWithSecrets } from "./secretExec";
import { execFileSync } from "node:child_process";

const tempRoots: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function makeProjectRoot(origin: string | null = "git@github.com:acme/project.git"): string {
  const root = tempDir("ade-project-secrets-");
  fs.mkdirSync(path.join(root, ".ade", "secrets"), { recursive: true });
  if (origin) {
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "config"), `[remote "origin"]\n\turl = ${origin}\n`, "utf8");
  }
  return root;
}

/** One account's relay: opaque rows, revisions, one key; `ifRevision` as the real relay checks it. */
function fakeRelay(): PasswordsRelay {
  const rows = new Map<string, PasswordRelayItem>();
  let clock = 0;
  const key = { dek: crypto.randomBytes(32).toString("base64"), epoch: 1 };
  return {
    async getPasswordItems() {
      return { items: [...rows.values()], cursor: null, truncated: false, epoch: key.epoch };
    },
    async putPasswordItems(items: PasswordRelayWrite[]) {
      return items.map((item) => {
        const stored = rows.get(item.id);
        const allowed = item.ifRevision === "absent" ? !stored : !item.ifRevision || stored?.revision === item.ifRevision;
        if (!allowed) return { id: item.id, status: "stale" as const, revision: stored?.revision ?? null };
        const revision = `r${(clock += 1)}`;
        rows.set(item.id, { id: item.id, ciphertext: item.deleted ? null : item.ciphertext ?? null, revision, deleted: Boolean(item.deleted) });
        return { id: item.id, status: "ok" as const, revision };
      });
    },
    async requestPasswordKey() {
      return key;
    },
  };
}

/** This computer's Passwords & Secrets, on a real encrypted file store (a new process can open it). */
function computer(options: { adeDir?: string; relay?: PasswordsRelay; signedIn?: () => boolean; now?: () => Date } = {}) {
  const adeDir = options.adeDir ?? tempDir("ade-home-");
  const relay = options.relay ?? fakeRelay();
  const store: CredentialStore = new EncryptedFileCredentialStore({
    credentialsPath: path.join(adeDir, "passwords", "passwords.v1.enc"),
    machineKeyPath: path.join(adeDir, "secrets", ".machine-key"),
    lockPath: path.join(adeDir, "passwords", "passwords.v1.enc.lock"),
  });
  const passwords = createPasswordService({
    adeDir,
    relay,
    getAccountUserId: () => (options.signedIn?.() ?? true) ? "user_a" : null,
    getDeviceId: () => "mac",
    machineKind: "desktop",
    store,
    ...(options.now ? { now: options.now } : {}),
  });
  return { adeDir, relay, passwords };
}

/** Secrets in the old per-project store, exactly as the old service wrote them. */
function writeLegacyStore(projectRoot: string, secrets: Array<{ name: string; value: string; storage: "account" | "device"; updatedAt: string }>): string {
  const dir = path.join(projectRoot, ".ade", "secrets");
  const credentialsPath = path.join(dir, "project-secrets.v1.enc");
  const store = new EncryptedFileCredentialStore({ credentialsPath, machineKeyPath: path.join(dir, ".project-secrets-key"), lockPath: `${credentialsPath}.lock` });
  store.updateSync((values) => {
    const entries: Record<string, unknown> = {};
    for (const secret of secrets) {
      values[`secret:${secret.name}`] = secret.value;
      entries[secret.name] = { createdAt: secret.updatedAt, updatedAt: secret.updatedAt, valueLength: secret.value.length, storage: secret.storage, source: "device", accountUserId: null };
    }
    values.__ade_project_secrets_index_v1 = JSON.stringify({ version: 1, entries });
  });
  return credentialsPath;
}

/** The account vault's old `project_secret` rows, as an older ADE left them. */
function legacyVault(items: AccountVaultItem[]): LegacySecretVault & { rows: Map<string, AccountVaultItem> } {
  const rows = new Map(items.map((item) => [`${item.scope}|${item.key}`, item]));
  return {
    rows,
    list: async (scope) => ({ ok: true as const, value: [...rows.values()].filter((item) => item.scope === scope).map((item) => ({ ...item, value: null })) }),
    get: async (scope, _kind, key) => ({ ok: true as const, value: rows.get(`${scope}|${key}`)?.value ?? null }),
    remove: async (scope, _kind, key) => {
      rows.delete(`${scope}|${key}`);
      return { ok: true as const, value: null };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const SCOPE = "repo:github.com/acme/project";

describe("a project's secrets in Passwords & Secrets", () => {
  it("moves the old per-project store in: account secrets for the repository, this-computer ones stay here, the newer value wins, and the old file goes", async () => {
    const root = makeProjectRoot();
    const file = writeLegacyStore(root, [
      { name: "STRIPE_KEY", value: "old-stripe", storage: "account", updatedAt: "2026-11-01T00:00:00.000Z" },
      { name: "LOCAL_TOKEN", value: "old-local", storage: "device", updatedAt: "2026-11-01T00:00:00.000Z" },
      { name: "NEWER_HERE", value: "old-value", storage: "account", updatedAt: "2026-11-01T00:00:00.000Z" },
    ]);
    const mac = computer({ now: () => new Date("2026-11-05T00:00:00.000Z") });
    await mac.passwords.saveSecret({ name: "NEWER_HERE", value: "kept-value", projectScope: SCOPE });
    const secrets = createProjectSecretService(root, { getPasswordService: () => mac.passwords });

    await secrets.migrateLegacy();

    const listed = (await secrets.listFresh()).secrets.map((secret) => [secret.name, secret.storage, secret.updatedAt]);
    expect(listed).toEqual([
      ["LOCAL_TOKEN", "device", "2026-11-01T00:00:00.000Z"],
      ["NEWER_HERE", "account", "2026-11-05T00:00:00.000Z"],
      ["STRIPE_KEY", "account", "2026-11-01T00:00:00.000Z"],
    ]);
    expect((await secrets.getFresh({ name: "STRIPE_KEY" })).value).toBe("old-stripe");
    expect((await secrets.getFresh({ name: "NEWER_HERE" })).value).toBe("kept-value");
    expect(fs.existsSync(file)).toBe(false);

    // The account's copy reaches another computer; this computer's own does not.
    const laptop = computer({ relay: mac.relay });
    await laptop.passwords.sync();
    const there = createProjectSecretService(makeProjectRoot(), { getPasswordService: () => laptop.passwords });
    expect((await there.listFresh()).secrets.map((secret) => secret.name)).toEqual(["NEWER_HERE", "STRIPE_KEY"]);
  });

  it("while the account can't be used, moves only this computer's secrets and keeps the old file until it can", async () => {
    const root = makeProjectRoot();
    const file = writeLegacyStore(root, [
      { name: "STRIPE_KEY", value: "old-stripe", storage: "account", updatedAt: "2026-11-01T00:00:00.000Z" },
      { name: "LOCAL_TOKEN", value: "old-local", storage: "device", updatedAt: "2026-11-01T00:00:00.000Z" },
    ]);
    let signedIn = false;
    const mac = computer({ signedIn: () => signedIn });
    const secrets = createProjectSecretService(root, { getPasswordService: () => mac.passwords });

    await secrets.migrateLegacy();
    expect(fs.existsSync(file)).toBe(true);
    // Waiting, a process still gets the old file's secret.
    expect(secrets.valuesForProcess()).toEqual({ LOCAL_TOKEN: "old-local", STRIPE_KEY: "old-stripe" });

    signedIn = true;
    await secrets.migrateLegacy();
    expect((await secrets.listFresh()).secrets.map((secret) => [secret.name, secret.storage])).toEqual([
      ["LOCAL_TOKEN", "device"],
      ["STRIPE_KEY", "account"],
    ]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("moves on two computers at once without a duplicate, and never brings back a secret deleted after the first move", async () => {
    const legacy = [{ name: "STRIPE_KEY", value: "old-stripe", storage: "account" as const, updatedAt: "2026-11-01T00:00:00.000Z" }];
    const mac = computer();
    const laptop = computer({ relay: mac.relay });
    const macRoot = makeProjectRoot();
    const laptopRoot = makeProjectRoot();
    writeLegacyStore(macRoot, legacy);
    writeLegacyStore(laptopRoot, legacy);
    const onMac = createProjectSecretService(macRoot, { getPasswordService: () => mac.passwords });
    const onLaptop = createProjectSecretService(laptopRoot, { getPasswordService: () => laptop.passwords });

    await Promise.all([onMac.migrateLegacy(), onLaptop.migrateLegacy()]);
    await mac.passwords.sync();
    await laptop.passwords.sync();

    const stripeItems = async (passwords: typeof mac.passwords) =>
      (await passwords.allSecretEntries()).filter((entry) => entry.name === "STRIPE_KEY");
    expect(await stripeItems(mac.passwords)).toHaveLength(1);
    expect(await stripeItems(laptop.passwords)).toHaveLength(1);

    // Deleted on the Mac; a third computer still holding the old file moves later.
    const [moved] = await stripeItems(mac.passwords);
    await mac.passwords.remove(moved!.id);
    await mac.passwords.sync();
    const studio = computer({ relay: mac.relay });
    const studioRoot = makeProjectRoot();
    writeLegacyStore(studioRoot, legacy);
    const onStudio = createProjectSecretService(studioRoot, { getPasswordService: () => studio.passwords });
    await onStudio.migrateLegacy();
    await studio.passwords.sync();
    expect(await stripeItems(studio.passwords)).toEqual([]);
  });

  it("moves the account's old rows, under the repository and its SSH-alias key, and clears them; a deleted row stays deleted", async () => {
    const root = makeProjectRoot("git@github.com:acme/project.git");
    const vault = legacyVault([
      { scope: SCOPE, kind: "project_secret", key: "FROM_ACCOUNT", value: "account-value", updatedAt: "2026-11-02T00:00:00.000Z" },
      { scope: SCOPE, kind: "project_secret", key: "GONE", value: null, updatedAt: "2026-11-02T00:00:00.000Z", deleted: true },
      { scope: SCOPE, kind: "provider_api_key", key: "anthropic", value: "not-a-secret-row", updatedAt: "2026-11-02T00:00:00.000Z" },
    ]);
    const mac = computer();
    const secrets = createProjectSecretService(root, { getPasswordService: () => mac.passwords, getAccountVault: () => vault });

    await secrets.migrateLegacy();

    expect((await secrets.listFresh()).secrets.map((secret) => secret.name)).toEqual(["FROM_ACCOUNT"]);
    expect((await secrets.getFresh({ name: "FROM_ACCOUNT" })).value).toBe("account-value");
    expect([...vault.rows.keys()].filter((key) => key.endsWith("FROM_ACCOUNT"))).toEqual([]);
    expect(vault.rows.has(`${SCOPE}|anthropic`)).toBe(true);
  });

  it("gives a project the secrets for every project, then its own; this computer's own wins; another project's stay out", async () => {
    const mac = computer();
    await mac.passwords.saveSecret({ name: "SHARED", value: "every-project", projectScope: null });
    await mac.passwords.saveSecret({ name: "SHARED", value: "this-project", projectScope: SCOPE });
    await mac.passwords.saveSecret({ name: "TOKEN", value: "account-token", projectScope: SCOPE });
    await mac.passwords.saveSecret({ name: "TOKEN", value: "local-token", projectScope: SCOPE, deviceOnly: true });
    await mac.passwords.saveSecret({ name: "OTHER", value: "other-project", projectScope: "repo:github.com/acme/other" });
    const secrets = createProjectSecretService(makeProjectRoot(), { getPasswordService: () => mac.passwords });

    expect(Object.fromEntries([...(await mac.passwords.secretsForProject(SCOPE)).values()].map((entry) => [entry.name, entry.value]))).toEqual({
      SHARED: "this-project",
      TOKEN: "local-token",
    });
    await expect(secrets.getFresh({ name: "OTHER" })).rejects.toThrow(/No secret named OTHER/);

    // A process that never opened the vault (a CLI command, a webhook check)
    // reads the same, without waiting, from what this computer holds.
    await mac.passwords.sync();
    const cold = computer({ adeDir: mac.adeDir, relay: mac.relay });
    const coldSecrets = createProjectSecretService(makeProjectRoot(), { getPasswordService: () => cold.passwords });
    expect(coldSecrets.valuesForProcess()).toEqual({ SHARED: "this-project", TOKEN: "local-token" });
    expect(coldSecrets.get({ name: "TOKEN" }).value).toBe("local-token");
  });
});

describe("project secret .env formatting", () => {
  it("parses common dotenv syntax and lets the last duplicate win", () => {
    expect(parseProjectSecretEnv([
      "# Project credentials",
      "export API_KEY = first",
      "QUOTED='value with # hash' # comment",
      'ESCAPED="line\\nnext\\tcolumn"',
      "API_KEY=last # replacement",
    ].join("\n"))).toEqual([
      { name: "API_KEY", value: "last" },
      { name: "QUOTED", value: "value with # hash" },
      { name: "ESCAPED", value: "line\nnext\tcolumn" },
    ]);
  });

  it("round-trips exported values", () => {
    const entries = [
      { name: "PLAIN", value: "abc-123/example" },
      { name: "HASH", value: "a value # with a hash" },
      { name: "QUOTES", value: "both 'single' and \"double\"" },
      { name: "MULTILINE", value: "first\nsecond" },
      { name: "TRAILING_SLASH", value: "it's a slash \\" },
    ];

    expect(parseProjectSecretEnv(formatProjectSecretEnv(entries))).toEqual(entries);
  });

  it("parses multiline quoted dotenv values", () => {
    expect(parseProjectSecretEnv('MULTILINE="first\nsecond"\nAFTER=value')).toEqual([
      { name: "MULTILINE", value: "first\nsecond" },
      { name: "AFTER", value: "value" },
    ]);
  });

  it("rejects a large unterminated multiline value", () => {
    const malformed = `BROKEN="${Array.from({ length: 10_000 }, () => "value").join("\n")}`;
    expect(() => parseProjectSecretEnv(malformed)).toThrow(/unterminated quoted value on line 1/);
  });

  it("reports malformed and empty variables with line context", () => {
    expect(() => parseProjectSecretEnv("GOOD=value\nnot-an-assignment")).toThrow(/line 2/);
    expect(() => parseProjectSecretEnv("EMPTY=")).toThrow(/empty value on line 1/);
    expect(() => parseProjectSecretEnv("# only comments")).toThrow(/does not contain any variables/);
  });
});

/**
 * The pull is how an account-scoped secret reaches a second machine, and the
 * account is the authority for one. These cover what it takes from the vault,
 * what it must never take, and what it must never write back.
 */
describe("createSecretTempFileStore", () => {
  it("keeps a secret only as long as its chat and lifetime allow, even when a removal fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-secret-temp-files-"));
    tempRoots.push(root);
    let clock = Date.parse("2026-10-26T12:00:00.000Z");
    const warn = vi.fn();
    const store = createSecretTempFileStore({ dir: path.join(root, "temp-files"), now: () => clock, logger: { info: vi.fn(), warn } });

    const kept = store.write({ chatSessionId: "chat-2", name: "API_KEY", value: "two", ttlMs: 60 * 60_000 });
    const held = store.write({ chatSessionId: "chat-1", name: "API_KEY", value: "one" });
    expect(fs.readFileSync(held.path, "utf8")).toBe("one");
    if (process.platform !== "win32") expect(fs.statSync(held.path).mode & 0o777).toBe(0o600);

    // Windows: something still has the file open when the chat ends.
    const realRm = fs.rmSync;
    const rm = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target) === held.path) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      return realRm(target, options);
    });
    expect(store.removeForChat("chat-1")).toBe(0);
    expect(warn).toHaveBeenCalledWith("project_secret.temp_file_remove_failed", expect.anything());

    // Once it is released, the next sweep takes it although it has not expired.
    rm.mockRestore();
    store.sweep();
    expect(fs.existsSync(held.path)).toBe(false);
    expect(fs.existsSync(kept.path)).toBe(true);

    clock += 60 * 60_000;
    store.sweep();
    expect(fs.existsSync(kept.path)).toBe(false);
    store.dispose();
  });
});

describe("runWithSecrets", () => {
  it("returns the output with every secret masked, and never puts a value in the result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-secret-exec-"));
    tempRoots.push(root);
    const value = "dtk_9f8e7d6c5b4a3210";
    const result = await runWithSecrets({
      command: [process.execPath, "-e", 'const v = process.env.DEPLOY_TOKEN; console.log("token=" + v); console.log(Buffer.from(v).toString("base64")); console.error("len " + v.length);'],
      cwd: root,
      allowedRoots: [root],
      secrets: { DEPLOY_TOKEN: value },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("token=[secret]");
    expect(JSON.stringify(result)).not.toContain(value);
    expect(JSON.stringify(result)).not.toContain(Buffer.from(value).toString("base64"));
    expect(result.stderr.trim()).toBe(`len ${value.length}`);
    expect(result.injected).toEqual(["DEPLOY_TOKEN"]);
  });

  // POSIX: the command's own process group. Windows uses `taskkill /T`
  // (`terminateProcessTree`), which its own tests cover.
  it.skipIf(process.platform === "win32")("on a timeout stops everything the command started, not only the command", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-secret-exec-"));
    tempRoots.push(root);
    // The background child prints its pid, then both it and the command wait.
    const result = await runWithSecrets({
      command: ["sh", "-c", "sleep 30 & echo $!; sleep 31"],
      cwd: root,
      allowedRoots: [root],
      secrets: { DEPLOY_TOKEN: "dtk_9f8e7d6c5b4a3210" }, // gitleaks:allow (a made-up test value)
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    const backgroundPid = Number(result.stdout.trim());
    expect(Number.isInteger(backgroundPid) && backgroundPid > 1, "the command printed its child's pid").toBe(true);
    // Signalled with the command's whole group: gone, or exiting as a zombie
    // of a parent that already died (then `ps` no longer lists it running).
    const alive = (() => {
      try {
        process.kill(backgroundPid, 0);
        // `ps` exits non-zero once the process is gone: not alive either.
        const state = execFileSync("ps", ["-o", "stat=", "-p", String(backgroundPid)], { encoding: "utf8" }).trim();
        return state !== "" && !state.startsWith("Z");
      } catch {
        return false;
      }
    })();
    expect(alive).toBe(false);
  });
});
