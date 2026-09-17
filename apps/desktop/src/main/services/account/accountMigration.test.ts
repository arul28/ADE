import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathKey } from "../shared/pathCompare";
import { runAccountMigration } from "./accountMigration";
import { createAccountMigrationRunner, getOpenAccountContexts } from "./accountMigrationRunner";
import type { AdeAccountStatus } from "../../../shared/types/account";

function signedInStatus(userId: string): AdeAccountStatus {
  return { signedIn: true, userId, email: null, name: null, expiresAt: null };
}

const receiptDirs: string[] = [];

function makeReceiptDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-account-migration-"));
  receiptDirs.push(dir);
  return dir;
}

function readReceipt(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, "account-migration.json"), "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of receiptDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runAccountMigration", () => {
  it("deduplicates migration contexts by project root", () => {
    const first = { project: { rootPath: "/repo" }, marker: "first" };
    const second = { project: { rootPath: "/repo" }, marker: "second" };
    const contexts = getOpenAccountContexts([
      first,
      { project: { rootPath: null }, marker: "unopened" },
      second,
    ]);

    expect(contexts).toEqual([second]);
  });

  it("completes each source once and records its counts", async () => {
    const receiptDir = makeReceiptDir();
    const provider = vi.fn(() => ({ moved: 2, skipped: 1 }));
    const linear = vi.fn(() => ({ moved: 0, skipped: 1 }));
    const sources = { provider_api_keys: provider, linear_credentials: linear };

    const first = await runAccountMigration({
      receiptDir,
      sources,
      getAccountUserId: () => "user-1",
      now: () => Date.parse("2026-09-16T12:00:00.000Z"),
    });
    const second = await runAccountMigration({
      receiptDir,
      sources,
      getAccountUserId: () => "user-1",
    });

    expect(first.completed.map(({ source }) => source)).toEqual([
      "provider_api_keys",
      "linear_credentials",
    ]);
    expect(second.completed).toEqual([]);
    expect(provider).toHaveBeenCalledOnce();
    expect(linear).toHaveBeenCalledOnce();
    expect(readReceipt(receiptDir)).toMatchObject({
      accountUserId: "user-1",
      sources: {
        provider_api_keys: { moved: 2, skipped: 1 },
        linear_credentials: { moved: 0, skipped: 1 },
      },
    });
  });

  it("persists completed sources before a later source fails and resumes it", async () => {
    const receiptDir = makeReceiptDir();
    let failProvider = true;
    const project = vi.fn(() => ({ moved: 1, skipped: 0 }));
    const provider = vi.fn(() => {
      if (failProvider) {
        expect(readReceipt(receiptDir)).toMatchObject({
          sources: { project_secrets: { moved: 1, skipped: 0 } },
        });
        throw new Error("vault unavailable");
      }
      return { moved: 0, skipped: 2 };
    });
    const sources = { project_secrets: project, provider_api_keys: provider };

    const first = await runAccountMigration({ receiptDir, sources });
    failProvider = false;
    const second = await runAccountMigration({ receiptDir, sources });

    expect(first.completed.map(({ source }) => source)).toEqual(["project_secrets"]);
    expect(first.failed).toEqual(["provider_api_keys"]);
    expect(second.completed.map(({ source }) => source)).toEqual(["provider_api_keys"]);
    expect(project).toHaveBeenCalledOnce();
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("A2: keeps a source pending when a vault write is rejected", async () => {
    const receiptDir = makeReceiptDir();
    const provider = vi
      .fn()
      .mockReturnValueOnce({ moved: 0, skipped: 0, complete: false })
      .mockReturnValueOnce({ moved: 1, skipped: 0 });
    const sources = { provider_api_keys: provider };

    const first = await runAccountMigration({ receiptDir, sources });
    const second = await runAccountMigration({ receiptDir, sources });

    expect(first.pending).toEqual(["provider_api_keys"]);
    expect(second.completed.map(({ source }) => source)).toEqual(["provider_api_keys"]);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("A1: abandons a migration when purge changes its account owner generation", async () => {
    const receiptDir = makeReceiptDir();
    const projectRoot = path.join(receiptDir, "project");
    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/acme/old-secrets.git\n`,
    );
    let userId = "user-a";
    let generation = 0;
    let releaseVaultWrite = (): void => {};
    let markVaultWriteStarted = (): void => {};
    const vaultWriteStarted = new Promise<void>((resolve) => {
      markVaultWriteStarted = resolve;
    });
    const vaultWriteGate = new Promise<void>((resolve) => {
      releaseVaultWrite = resolve;
    });
    const writes: string[] = [];
    const vault = {
      list: vi.fn(async (scope?: string | null) => scope === "all"
        ? { ok: false as const, unavailable: true as const, message: "offline" }
        : { ok: true as const, value: [] }),
      get: vi.fn(async () => ({ ok: true as const, value: null })),
      set: vi.fn(async (_scope: string, _kind: string, _key: string, value: string) => {
        const writeGeneration = generation;
        markVaultWriteStarted();
        await vaultWriteGate;
        if (writeGeneration === generation) writes.push(value);
        return { ok: true as const, value: null };
      }),
    };
    const runner = createAccountMigrationRunner({
      accountBridge: { status: () => signedInStatus(userId) },
      accountVaultBridge: vault,
      getContexts: () => [{
        project: { rootPath: projectRoot },
        projectSecretService: {
          list: () => ({ secrets: [{ name: "old-secret", storage: "account" }] }),
          getSecretProvenance: () => ({ source: "device" as const, accountUserId: null }),
          get: () => ({ value: "old-secret" }),
          hydrateFromVault: vi.fn(async () => {}),
        },
      }],
      getLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
      getReceiptDir: () => receiptDir,
      getAccountMigrationGeneration: () => generation,
    });

    runner.start();
    await vaultWriteStarted;
    userId = "user-b";
    generation += 1;
    releaseVaultWrite();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(writes).toEqual([]);
    expect(vault.set).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(receiptDir, "account-migration.json"))).toBe(false);
  });

  it("start() declines while a previous owner's run is still in flight, so the lifecycle retries", async () => {
    const receiptDir = makeReceiptDir();
    let releaseVaultWrite: () => void = () => {};
    const vaultWriteGate = new Promise<void>((resolve) => {
      releaseVaultWrite = resolve;
    });
    const vault = {
      list: vi.fn(async () => ({ ok: true as const, value: [] })),
      get: vi.fn(async () => ({ ok: true as const, value: null })),
      set: vi.fn(async () => {
        await vaultWriteGate;
        return { ok: true as const, value: null };
      }),
    };
    const runner = createAccountMigrationRunner({
      accountBridge: { status: () => signedInStatus("user-a") },
      accountVaultBridge: vault,
      getContexts: () => [{
        project: { rootPath: makeReceiptDir() },
        projectSecretService: {
          list: () => ({ secrets: [{ name: "s", storage: "account" }] }),
          getSecretProvenance: () => ({ source: "device" as const, accountUserId: null }),
          get: () => ({ value: "v" }),
          hydrateFromVault: vi.fn(async () => {}),
        },
      }],
      getLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
      getReceiptDir: () => receiptDir,
      getAccountMigrationGeneration: () => 0,
    });

    expect(runner.start()).toBe(true);
    // A second caller (an account switch, a later ready tick) must be told
    // nothing began, so it can try again once this run winds down.
    expect(runner.start()).toBe(false);
    releaseVaultWrite();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runner.start()).toBe(true);
  });

  it("does not record project-secret migration complete while a project scope is unresolved", async () => {
    const receiptDir = makeReceiptDir();
    const projectSecrets = vi.fn(() => ({ moved: 0, skipped: 0, complete: false }));

    const first = await runAccountMigration({
      receiptDir,
      sources: { project_secrets: projectSecrets },
    });
    const second = await runAccountMigration({
      receiptDir,
      sources: { project_secrets: projectSecrets },
    });

    expect(first.pending).toEqual(["project_secrets"]);
    expect(second.pending).toEqual(["project_secrets"]);
    expect(projectSecrets).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(receiptDir, "account-migration.json"))).toBe(false);
  });

  it("A3: records project-secret migration separately for each project root", async () => {
    const receiptDir = makeReceiptDir();
    const projectOne = path.join(os.tmpdir(), "ade-project-one");
    const projectTwo = path.join(os.tmpdir(), "ade-project-two");
    const migrateOne = vi.fn(() => ({ moved: 1, skipped: 0 }));
    const migrateTwo = vi.fn(() => ({ moved: 2, skipped: 0 }));

    await runAccountMigration({
      receiptDir,
      projectRoot: projectOne,
      sources: { project_secrets: migrateOne },
      getAccountUserId: () => "user-1",
    });
    await runAccountMigration({
      receiptDir,
      projectRoot: projectOne,
      sources: { project_secrets: migrateOne },
      getAccountUserId: () => "user-1",
    });
    await runAccountMigration({
      receiptDir,
      projectRoot: projectTwo,
      sources: { project_secrets: migrateTwo },
      getAccountUserId: () => "user-1",
    });
    await runAccountMigration({
      receiptDir,
      projectRoot: projectTwo,
      sources: { project_secrets: migrateTwo },
      getAccountUserId: () => "user-1",
    });

    expect(migrateOne).toHaveBeenCalledOnce();
    expect(migrateTwo).toHaveBeenCalledOnce();
    expect(readReceipt(receiptDir)).toMatchObject({
      sources: {},
      projectSources: {
        [pathKey(path.resolve(projectOne))]: { project_secrets: { moved: 1, skipped: 0 } },
        [pathKey(path.resolve(projectTwo))]: { project_secrets: { moved: 2, skipped: 0 } },
      },
    });
  });

  it("A3: migrates secrets for a project opened after an earlier project", async () => {
    const receiptDir = makeReceiptDir();
    const projectOne = fs.mkdtempSync(path.join(os.tmpdir(), "ade-open-project-one-"));
    const projectTwo = fs.mkdtempSync(path.join(os.tmpdir(), "ade-open-project-two-"));
    const roots = [projectOne, projectTwo];
    for (const [root, repository] of [[projectOne, "one"], [projectTwo, "two"]] as const) {
      fs.mkdirSync(path.join(root, ".git"));
      fs.writeFileSync(
        path.join(root, ".git", "config"),
        `[remote "origin"]\n\turl = https://github.com/acme/${repository}.git\n`,
      );
    }
    const makeContext = (root: string, name: string, value: string) => ({
      project: { rootPath: root },
      projectSecretService: {
        list: () => ({ secrets: [{ name, storage: "account" }] }),
        getSecretProvenance: () => ({ source: "device" as const, accountUserId: null }),
        get: () => ({ value }),
        hydrateFromVault: vi.fn(async () => {}),
      },
    });
    const contextOne = makeContext(projectOne, "first-secret", "first-value");
    const contextTwo = makeContext(projectTwo, "second-secret", "second-value");
    let contexts = [contextOne];
    const vault = {
      list: vi.fn(async () => ({ ok: true as const, value: [] })),
      get: vi.fn(async () => ({ ok: true as const, value: null })),
      set: vi.fn(async () => ({ ok: true as const, value: null })),
    };
    const runner = createAccountMigrationRunner({
      getAccountMigrationGeneration: () => 0,
      accountBridge: {
        status: () => signedInStatus("user-1"),
      },
      accountVaultBridge: vault,
      getContexts: () => contexts,
      getLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
      getReceiptDir: () => receiptDir,
    });

    try {
      runner.start();
      await vi.waitFor(() => expect(vault.set).toHaveBeenCalledWith(
        "repo:github.com/acme/one",
        "project_secret",
        "first-secret",
        "first-value",
      ));

      contexts = [contextOne, contextTwo];
      runner.start();
      await vi.waitFor(() => expect(vault.set).toHaveBeenCalledWith(
        "repo:github.com/acme/two",
        "project_secret",
        "second-secret",
        "second-value",
      ));
    } finally {
      for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
