import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EncryptedFileCredentialStore } from "../credentials/credentialStore";
import { createHeadlessLinearCredentialService } from "./headlessLinearCredentialService";

describe("headless Linear credential service", () => {
  it("hydrates a vault refresh token with OAuth mode", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-linear-vault-"));
    const adeDir = path.join(projectRoot, ".ade");
    const vault = {
      list: vi.fn(async () => ({ ok: true as const, value: [] })),
      get: vi.fn(async () => ({ ok: true as const, value: "remote-refresh-token" })),
      set: vi.fn(async () => ({ ok: true as const, value: null })),
      remove: vi.fn(async () => ({ ok: true as const, value: null })),
      sync: vi.fn(async () => ({ ok: true as const, value: null })),
    };
    const service = createHeadlessLinearCredentialService({
      adeDir,
      getAccountVault: () => vault,
      getAccountUserId: () => "user_ada",
    });
    try {
      await service.hydrateFromVault();

      expect(service.getRefreshToken()).toBe("remote-refresh-token");
      expect(service.getRefreshTokenProvenance()).toEqual({
        source: "account",
        accountUserId: "user_ada",
      });
      expect(service.getStatus().authMode).toBe("oauth");
      expect(new EncryptedFileCredentialStore({ secretsDir: path.join(adeDir, "secrets") })
        .getSync("linear.authMode.v1"))
        .toBe("oauth");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("A1: does not hydrate or change an environment Linear token", async () => {
    const previous = {
      adeLinearApi: process.env.ADE_LINEAR_API,
      linearApiKey: process.env.LINEAR_API_KEY,
      adeLinearToken: process.env.ADE_LINEAR_TOKEN,
      linearToken: process.env.LINEAR_TOKEN,
    };
    process.env.ADE_LINEAR_API = "env-linear-token";
    delete process.env.LINEAR_API_KEY;
    delete process.env.ADE_LINEAR_TOKEN;
    delete process.env.LINEAR_TOKEN;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-headless-linear-env-"));
    const vault = {
      list: vi.fn(async () => ({ ok: true as const, value: [] })),
      get: vi.fn(async () => ({ ok: true as const, value: "remote-refresh-token" })),
      set: vi.fn(async () => ({ ok: true as const, value: null })),
      remove: vi.fn(async () => ({ ok: true as const, value: null })),
      sync: vi.fn(async () => ({ ok: true as const, value: null })),
    };
    const service = createHeadlessLinearCredentialService({
      adeDir: path.join(projectRoot, ".ade"),
      getAccountVault: () => vault,
      getAccountUserId: () => "user_ada",
    });
    try {
      expect(service.getTokenOrThrow()).toBe("env-linear-token");
      expect(service.getStatus().authMode).toBe("manual");

      await service.hydrateFromVault();

      expect(vault.get).not.toHaveBeenCalled();
      expect(service.getTokenOrThrow()).toBe("env-linear-token");
      expect(service.getStatus().authMode).toBe("manual");
      expect(service.getRefreshToken()).toBeNull();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      if (previous.adeLinearApi == null) delete process.env.ADE_LINEAR_API;
      else process.env.ADE_LINEAR_API = previous.adeLinearApi;
      if (previous.linearApiKey == null) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previous.linearApiKey;
      if (previous.adeLinearToken == null) delete process.env.ADE_LINEAR_TOKEN;
      else process.env.ADE_LINEAR_TOKEN = previous.adeLinearToken;
      if (previous.linearToken == null) delete process.env.LINEAR_TOKEN;
      else process.env.LINEAR_TOKEN = previous.linearToken;
    }
  });
});
