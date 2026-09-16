import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatProjectSecretEnv, parseProjectSecretEnv } from "./projectSecretEnv";
import { createProjectSecretService } from "./projectSecretService";
import type { AccountVaultBridge } from "../account/accountVaultBridge";

const tempRoots: string[] = [];

function makeProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-secrets-"));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, ".ade"), { recursive: true });
  return root;
}

function addOrigin(projectRoot: string, origin = "git@github.com:acme/project.git"): void {
  fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".git", "config"), `[remote "origin"]\n\turl = ${origin}\n`, "utf8");
}

function makeVaultMock(): AccountVaultBridge & {
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  return {
    list: vi.fn(async () => ({ ok: true as const, value: [] })),
    get: vi.fn(async () => ({ ok: true as const, value: null })),
    set: vi.fn(async () => ({ ok: true as const, value: null })),
    remove: vi.fn(async () => ({ ok: true as const, value: null })),
    sync: vi.fn(async () => ({ ok: true as const, value: null })),
  } as unknown as AccountVaultBridge & {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("createProjectSecretService", () => {
  it("stores values encrypted while listing only metadata", () => {
    const projectRoot = makeProjectRoot();
    const service = createProjectSecretService(projectRoot);

    const secretValue = " sk_test_secret ";
    const saved = service.set({ name: "STRIPE_API_KEY", value: secretValue });

    expect(saved.name).toBe("STRIPE_API_KEY");
    expect(saved.valueLength).toBe(secretValue.length);
    expect(saved.storage).toBe("device");
    expect(service.get({ name: "STRIPE_API_KEY" }).value).toBe(secretValue);
    expect(service.list().secrets).toEqual([
      expect.objectContaining({
        name: "STRIPE_API_KEY",
        valueLength: secretValue.length,
        storage: "device",
      }),
    ]);

    const encryptedPath = path.join(projectRoot, ".ade", "secrets", "project-secrets.v1.enc");
    expect(fs.existsSync(encryptedPath)).toBe(true);
    expect(fs.readFileSync(encryptedPath, "utf8")).not.toContain("sk_test_secret");
  });

  it("writes account secrets to the repository-scoped account vault", () => {
    const projectRoot = makeProjectRoot();
    addOrigin(projectRoot);
    const vault = makeVaultMock();
    const service = createProjectSecretService(projectRoot, { getAccountVault: () => vault });

    const saved = service.set({ name: "ACCOUNT_TOKEN", value: "account-value", storage: "account" });

    expect(saved.storage).toBe("account");
    expect(service.list().secrets).toEqual([
      expect.objectContaining({ name: "ACCOUNT_TOKEN", storage: "account" }),
    ]);
    expect(vault.set).toHaveBeenCalledWith(
      "repo:github.com/acme/project",
      "project_secret",
      "ACCOUNT_TOKEN",
      "account-value",
    );
  });

  it("keeps device-only secrets local and falls back when there is no remote", () => {
    const projectRoot = makeProjectRoot();
    const vault = makeVaultMock();
    const service = createProjectSecretService(projectRoot, { getAccountVault: () => vault });

    const saved = service.set({ name: "LOCAL_TOKEN", value: "local-value", storage: "account" });

    expect(saved.storage).toBe("device");
    expect(service.list().secrets[0]?.storage).toBe("device");
    expect(vault.set).not.toHaveBeenCalled();
  });

  it("hydrates missing repository account secrets without overwriting local values", async () => {
    const projectRoot = makeProjectRoot();
    addOrigin(projectRoot);
    const vault = makeVaultMock();
    vault.list.mockResolvedValue({
      ok: true,
      value: [{
        scope: "repo:github.com/acme/project",
        kind: "project_secret",
        key: "FROM_ACCOUNT",
        value: null,
        updatedAt: "2026-07-16T00:00:00.000Z",
      }],
    });
    vault.get.mockResolvedValue({ ok: true, value: "account-value" });
    const service = createProjectSecretService(projectRoot, { getAccountVault: () => vault });

    await service.hydrateFromVault();

    expect(service.get({ name: "FROM_ACCOUNT" })).toEqual(expect.objectContaining({
      name: "FROM_ACCOUNT",
      value: "account-value",
      storage: "account",
    }));
    expect(vault.get).toHaveBeenCalledWith(
      "repo:github.com/acme/project",
      "project_secret",
      "FROM_ACCOUNT",
    );
    expect(vault.set).not.toHaveBeenCalled();
  });

  it("removes an account secret from the vault when changed to device-only", () => {
    const projectRoot = makeProjectRoot();
    addOrigin(projectRoot);
    const vault = makeVaultMock();
    const service = createProjectSecretService(projectRoot, { getAccountVault: () => vault });
    service.set({ name: "MOVE_ME", value: "account-value", storage: "account" });
    vault.set.mockClear();

    service.set({ name: "MOVE_ME", value: "device-value", storage: "device" });

    expect(vault.remove).toHaveBeenCalledWith(
      "repo:github.com/acme/project",
      "project_secret",
      "MOVE_ME",
    );
  });

  it("requires delete confirmation to match the secret name", () => {
    const service = createProjectSecretService(makeProjectRoot());
    service.set({ name: "OPENAI_API_KEY", value: "sk-test" });

    expect(() => service.delete({ name: "OPENAI_API_KEY" })).toThrow(/requires confirmName/);
    expect(() => service.delete({ name: "OPENAI_API_KEY", confirmName: "OTHER" })).toThrow(/requires confirmName/);

    expect(service.delete({ name: "OPENAI_API_KEY", confirmName: "OPENAI_API_KEY" })).toEqual({
      deleted: true,
      name: "OPENAI_API_KEY",
    });
    expect(service.list().secrets).toEqual([]);
  });

  it("does not create secret files for empty list or no-op delete", () => {
    const projectRoot = makeProjectRoot();
    const service = createProjectSecretService(projectRoot);
    const encryptedPath = path.join(projectRoot, ".ade", "secrets", "project-secrets.v1.enc");

    expect(service.list().secrets).toEqual([]);
    expect(service.delete({ name: "MISSING_SECRET", confirmName: "MISSING_SECRET" })).toEqual({
      deleted: false,
      name: "MISSING_SECRET",
    });
    expect(fs.existsSync(encryptedPath)).toBe(false);
  });

  it("validates secret names", () => {
    const service = createProjectSecretService(makeProjectRoot());

    expect(() => service.set({ name: "1BAD", value: "value" })).toThrow(/Secret names must start/);
    expect(() => service.set({ name: "BAD NAME", value: "value" })).toThrow(/Secret names must start/);
  });

  it("previews replacements and imports selected env values atomically", () => {
    const service = createProjectSecretService(makeProjectRoot());
    service.set({ name: "EXISTING", value: "old" });

    expect(service.previewEnvImport({
      fileName: "/Users/local/Downloads/.env.production",
      content: "EXISTING=new\nNEW_SECRET='new value'\n",
    })).toEqual({
      fileName: ".env.production",
      secrets: [
        { name: "EXISTING", value: "new", exists: true },
        { name: "NEW_SECRET", value: "new value", exists: false },
      ],
    });

    expect(service.importEnv({
      secrets: [
        { name: "EXISTING", value: "new" },
        { name: "NEW_SECRET", value: "new value" },
      ],
    })).toEqual({ imported: ["NEW_SECRET"], replaced: ["EXISTING"] });
    expect(service.get({ name: "EXISTING" }).value).toBe("new");
    expect(service.get({ name: "NEW_SECRET" }).value).toBe("new value");

    expect(() => service.importEnv({
      secrets: [
        { name: "WILL_NOT_SAVE", value: "value" },
        { name: "INVALID NAME", value: "value" },
      ],
    })).toThrow(/Secret names must start/);
    expect(service.list().secrets.map((secret) => secret.name)).not.toContain("WILL_NOT_SAVE");
  });

  it("exports sorted dotenv files to a unique path in Downloads", () => {
    const projectRoot = makeProjectRoot();
    const downloadsDir = path.join(projectRoot, "Downloads");
    const service = createProjectSecretService(projectRoot, { downloadsDir });
    service.set({ name: "Z_LAST", value: "contains # hash" });
    service.set({ name: "A_FIRST", value: "plain-value" });

    const first = service.exportEnv();
    const second = service.exportEnv();

    expect(first).toEqual({ filePath: path.join(downloadsDir, "ade-secrets.env"), secretCount: 2 });
    expect(second.filePath).toBe(path.join(downloadsDir, "ade-secrets (1).env"));
    expect(fs.readFileSync(first.filePath, "utf8")).toBe("A_FIRST=plain-value\nZ_LAST='contains # hash'\n");
    expect(fs.statSync(first.filePath).mode & 0o777).toBe(0o600);
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
