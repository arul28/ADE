import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAccountMigrationReceipt,
  MIGRATION_SOURCES,
} from "./accountMigrationReceipt";

/**
 * Migration is silent and automatic, which raises the bar on this file rather
 * than lowering it. Nobody is watching, so a half-run that repeats, or a source
 * marked done before the account confirmed it, is a loss the user would not
 * notice until it mattered.
 */

describe("account migration receipt", () => {
  let adeDir: string;
  let accountUserId: string | null;

  beforeEach(() => {
    adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-migration-"));
    accountUserId = "user_ada";
  });

  afterEach(() => {
    fs.rmSync(adeDir, { recursive: true, force: true });
  });

  const makeReceipt = () =>
    createAccountMigrationReceipt({ adeDir, getAccountUserId: () => accountUserId });

  it("starts with everything pending", () => {
    const receipt = makeReceipt();
    expect(receipt.pending()).toEqual([...MIGRATION_SOURCES]);
    expect(receipt.summary()).toHaveLength(0);
  });

  it("records a finished source and stops reporting it as pending", () => {
    const receipt = makeReceipt();
    receipt.complete("project_secrets", { moved: 12, skipped: 0 });

    expect(receipt.isComplete("project_secrets")).toBe(true);
    expect(receipt.pending()).not.toContain("project_secrets");
    expect(receipt.summary()).toMatchObject([
      { source: "project_secrets", moved: 12, skipped: 0 },
    ]);
  });

  // A crash must resume, not repeat. Repeating would resurrect a secret the
  // user deleted after the first pass.
  it("survives a restart", () => {
    makeReceipt().complete("provider_api_keys", { moved: 3, skipped: 1 });

    const reopened = makeReceipt();
    expect(reopened.isComplete("provider_api_keys")).toBe(true);
    expect(reopened.pending()).not.toContain("provider_api_keys");
  });

  it("tracks each source independently", () => {
    const receipt = makeReceipt();
    receipt.complete("project_secrets", { moved: 1, skipped: 0 });

    expect(receipt.isComplete("project_secrets")).toBe(true);
    expect(receipt.isComplete("provider_api_keys")).toBe(false);
    expect(receipt.isComplete("linear_credentials")).toBe(false);
  });

  // Zero moved is the common case, not a failure: the first machine fills the
  // account and every machine after it finds the keys already there.
  it("treats zero moved as a real completion", () => {
    const receipt = makeReceipt();
    receipt.complete("provider_api_keys", { moved: 0, skipped: 4 });

    expect(receipt.isComplete("provider_api_keys")).toBe(true);
    expect(receipt.summary()).toMatchObject([{ moved: 0, skipped: 4 }]);
  });

  // A receipt written for one account proves nothing about another. Trusting it
  // would skip a migration that has never run for the signed-in user.
  it("ignores a receipt belonging to a different account", () => {
    makeReceipt().complete("project_secrets", { moved: 5, skipped: 0 });

    accountUserId = "user_grace";
    const other = makeReceipt();
    expect(other.isComplete("project_secrets")).toBe(false);
    expect(other.pending()).toEqual([...MIGRATION_SOURCES]);
  });

  it("treats an unreadable receipt as nothing done rather than everything done", () => {
    const receipt = makeReceipt();
    receipt.complete("project_secrets", { moved: 1, skipped: 0 });
    fs.writeFileSync(receipt.receiptPathForTests(), "{ not json");

    expect(makeReceipt().pending()).toEqual([...MIGRATION_SOURCES]);
  });

  // Same reasoning in the other direction: a receipt from a future version
  // describes sources this build may not have, so it cannot be trusted to mean
  // "already done".
  it("ignores a receipt from an unknown version", () => {
    const receipt = makeReceipt();
    receipt.complete("project_secrets", { moved: 1, skipped: 0 });
    const stored = JSON.parse(fs.readFileSync(receipt.receiptPathForTests(), "utf8"));
    stored.version = 99;
    fs.writeFileSync(receipt.receiptPathForTests(), JSON.stringify(stored));

    expect(makeReceipt().isComplete("project_secrets")).toBe(false);
  });

  it("writes the receipt with owner-only permissions", () => {
    const receipt = makeReceipt();
    receipt.complete("project_secrets", { moved: 1, skipped: 0 });

    expect(fs.statSync(receipt.receiptPathForTests()).mode & 0o777).toBe(0o600);
  });

  it("A4: maps Windows path spellings of one project to one receipt key", () => {
    const projectRoot = path.join(adeDir, "Project");
    const aliasRoot = path.join(adeDir, "PROJECT");
    fs.mkdirSync(projectRoot);
    const receipt = createAccountMigrationReceipt({
      adeDir,
      getAccountUserId: () => accountUserId,
      platform: "win32",
    });

    receipt.complete("project_secrets", { moved: 1, skipped: 0 }, { projectRoot });

    expect(receipt.isComplete("project_secrets", { projectRoot: aliasRoot })).toBe(true);
    const stored = JSON.parse(fs.readFileSync(receipt.receiptPathForTests(), "utf8")) as {
      projectSources?: Record<string, unknown>;
    };
    expect(Object.keys(stored.projectSources ?? {})).toHaveLength(1);
  });

  it("keeps earlier sources when a later one completes", () => {
    const receipt = makeReceipt();
    receipt.complete("project_secrets", { moved: 2, skipped: 0 });
    receipt.complete("linear_credentials", { moved: 1, skipped: 0 });

    expect(receipt.summary().map((entry) => entry.source)).toEqual([
      "project_secrets",
      "linear_credentials",
    ]);
  });
});
