import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLinearCredentialService } from "./linearCredentialService";

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`, "utf8")),
  decryptString: vi.fn((value: Buffer) => {
    const raw = value.toString("utf8");
    return raw.startsWith("enc:") ? raw.slice(4) : raw;
  }),
}));

vi.mock("electron", () => ({
  safeStorage: safeStorageMock,
}));

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

describe("linearCredentialService", () => {
  beforeEach(() => {
    safeStorageMock.isEncryptionAvailable.mockReset();
    safeStorageMock.encryptString.mockReset();
    safeStorageMock.decryptString.mockReset();
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(`enc:${value}`, "utf8"));
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => {
      const raw = value.toString("utf8");
      return raw.startsWith("enc:") ? raw.slice(4) : raw;
    });
  });

  it("stores token encrypted and reads it back", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-cred-"));
    const adeDir = path.join(root, ".ade");
    const service = createLinearCredentialService({
      adeDir,
      logger: createLogger(),
    });

    service.setToken("lin_api_123");
    expect(service.getToken()).toBe("lin_api_123");
    expect(service.getStatus().tokenStored).toBe(true);

    const tokenPath = path.join(adeDir, "secrets", "linear-token.v1.bin");
    expect(fs.existsSync(tokenPath)).toBe(true);
    const onDisk = fs.readFileSync(tokenPath);
    expect(onDisk.toString("utf8")).toMatch(/^enc:/);
  });

  it("imports token once from legacy local.secret.yaml when encrypted store is empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-legacy-"));
    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });
    fs.writeFileSync(
      path.join(adeDir, "local.secret.yaml"),
      "linear:\n  token: lin_legacy_abc\n",
      "utf8"
    );

    const service = createLinearCredentialService({
      adeDir,
      logger: createLogger(),
    });

    expect(service.getToken()).toBe("lin_legacy_abc");

    const sentinelPath = path.join(adeDir, "secrets", "linear-token.imported.v1");
    expect(fs.existsSync(sentinelPath)).toBe(true);
    expect(fs.readFileSync(sentinelPath, "utf8")).toContain("imported");
  });

  it("reads Linear OAuth client credentials from .ade/secrets", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-oauth-"));
    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(path.join(adeDir, "secrets"), { recursive: true });
    fs.writeFileSync(
      path.join(adeDir, "secrets", "linear-oauth.v1.json"),
      JSON.stringify({ clientId: "client-123", clientSecret: "secret-456" }),
      "utf8"
    );

    const service = createLinearCredentialService({
      adeDir,
      logger: createLogger(),
    });

    expect(service.getOAuthClientCredentials()).toEqual({
      clientId: "client-123",
      clientSecret: "secret-456",
    });
    expect(service.getStatus().oauthConfigured).toBe(true);
  });

  it("stores Linear OAuth client credentials without requiring a secret", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-oauth-store-"));
    const adeDir = path.join(root, ".ade");
    const service = createLinearCredentialService({
      adeDir,
      logger: createLogger(),
    });

    service.setOAuthClientCredentials({ clientId: "client-public" });

    expect(service.getOAuthClientCredentials()).toEqual({
      clientId: "client-public",
      clientSecret: null,
    });
    expect(service.getStatus().oauthConfigured).toBe(true);

    const clientPath = path.join(adeDir, "secrets", "linear-oauth-client.v1.bin");
    expect(fs.existsSync(clientPath)).toBe(true);
    expect(fs.readFileSync(clientPath).toString("utf8")).toMatch(/^enc:/);
  });
});
