import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatProjectSecretEnv, parseProjectSecretEnv } from "./projectSecretEnv";
import { createProjectSecretService } from "./projectSecretService";

const tempRoots: string[] = [];

function makeProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-secrets-"));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, ".ade"), { recursive: true });
  return root;
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
    expect(service.get({ name: "STRIPE_API_KEY" }).value).toBe(secretValue);
    expect(service.list().secrets).toEqual([
      expect.objectContaining({
        name: "STRIPE_API_KEY",
        valueLength: secretValue.length,
      }),
    ]);

    const encryptedPath = path.join(projectRoot, ".ade", "secrets", "project-secrets.v1.enc");
    expect(fs.existsSync(encryptedPath)).toBe(true);
    expect(fs.readFileSync(encryptedPath, "utf8")).not.toContain("sk_test_secret");
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

  it("reports malformed and empty variables with line context", () => {
    expect(() => parseProjectSecretEnv("GOOD=value\nnot-an-assignment")).toThrow(/line 2/);
    expect(() => parseProjectSecretEnv("EMPTY=")).toThrow(/empty value on line 1/);
    expect(() => parseProjectSecretEnv("# only comments")).toThrow(/does not contain any variables/);
  });
});
