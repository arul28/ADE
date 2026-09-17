import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAccountMigration } from "./accountMigration";
import { getOpenAccountContexts } from "./accountMigrationRunner";

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
});
