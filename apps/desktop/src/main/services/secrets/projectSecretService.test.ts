import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
