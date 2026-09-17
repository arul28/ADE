import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AccountMigrationContext } from "../../../../desktop/src/main/services/account/accountMigrationRunner";
import type { AccountAuthStatus } from "./accountAuthService";
import type { AccountSettingsRelay } from "./accountSettingsStore";
import type { AccountVaultRelay } from "./accountVaultStore";
import type {
  AccountSettingRecord,
  AccountSettingWrite,
  AccountVaultItem,
  AccountVaultWrite,
} from "../push/accountRelayRows";
import { createAccountRuntimeLifecycle } from "./accountRuntimeLifecycle";

const accountKeyStoreMocks = vi.hoisted(() => ({
  purgeAccountApiKeys: vi.fn(),
  hydrateApiKeysFromVault: vi.fn(async () => {}),
  getAllApiKeys: vi.fn(() => ({})),
  getApiKeyProvenance: vi.fn(() => ({ source: "device", accountUserId: null })),
}));

vi.mock("../../../../desktop/src/main/services/ai/apiKeyStore", () => accountKeyStoreMocks);

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeAuth() {
  let status: AccountAuthStatus = {
    signedIn: true,
    userId: "user_ada",
    email: null,
    name: null,
    expiresAt: null,
  };
  const signedIn = new Set<() => void>();
  const signedOut = new Set<() => void>();
  return {
    service: {
      getStatus: () => status,
      onSignedIn(listener: () => void) {
        signedIn.add(listener);
        return () => signedIn.delete(listener);
      },
      onSignedOut(listener: () => void) {
        signedOut.add(listener);
        return () => signedOut.delete(listener);
      },
    },
    emitSignedOut() {
      status = { ...status, signedIn: false, userId: null };
      for (const listener of signedOut) listener();
    },
    emitSignedIn(userId = "user_ada") {
      status = { ...status, signedIn: true, userId };
      for (const listener of signedIn) listener();
    },
  };
}

function makeRelay(remoteItems: AccountVaultItem[] = []): AccountSettingsRelay & AccountVaultRelay {
  const settings: AccountSettingRecord[] = [];
  return {
    getAccountSettings: vi.fn(async () => ({ settings, cursor: null, truncated: false })),
    putAccountSettings: vi.fn(async (_writes: AccountSettingWrite[], _deviceId: string | null) => ({
      updatedAt: new Date().toISOString(),
    })),
    deleteAccountSetting: vi.fn(async () => true),
    getAccountVault: vi.fn(async () => ({ items: remoteItems, cursor: null, truncated: false })),
    putAccountVault: vi.fn(async (_writes: AccountVaultWrite[], _deviceId: string | null) => ({
      updatedAt: new Date().toISOString(),
    })),
    deleteAccountVaultItem: vi.fn(async () => true),
  };
}

function makeContext(overrides: Partial<AccountMigrationContext> = {}): AccountMigrationContext {
  return {
    project: { rootPath: "/tmp/ade-runtime-project" },
    linearCredentialService: {
      getRefreshToken: () => null,
      getRefreshTokenProvenance: () => ({ source: "device", accountUserId: null }),
      hydrateFromVault: vi.fn(async () => {}),
      purgeAccountCredentials: vi.fn(),
    },
    projectSecretService: {
      list: () => ({ secrets: [] }),
      getSecretProvenance: () => null,
      get: () => ({ value: "" }),
      hydrateFromVault: vi.fn(async () => {}),
      purgeAccountCredentials: vi.fn(),
    },
    ...overrides,
  };
}

function makeLifecycleArgs(overrides: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-account-runtime-lifecycle-"));
  const auth = makeAuth();
  const releases: Array<() => void> = [];
  const logger = makeLogger();
  const relay = makeRelay();
  const context = makeContext({ project: { rootPath: root } });
  const purgeAccountApiKeys = vi.fn();
  const args = {
    enabled: true,
    accountStoreAdeDir: path.join(root, "machine"),
    pushRelayFilePath: path.join(root, "push-relay.json"),
    syncDeviceIdPath: path.join(root, "sync-device-id"),
    receiptDir: path.join(root, "machine"),
    logger,
    accountAuthService: auth.service,
    getAccountAccessToken: async () => "account-token",
    getContexts: () => [context],
    projectSecretReceiptRoot: root,
    teardown: { push: (release: () => void) => releases.push(release) },
    relay,
    purgeAccountApiKeys,
    ...overrides,
  };
  return {
    root,
    auth,
    context,
    logger,
    purgeAccountApiKeys,
    relay,
    releases,
    args,
    cleanup() {
      while (releases.length) releases.pop()?.();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("account runtime lifecycle", () => {
  it("A2: pulls the remote vault before first-boot migration", async () => {
    const remoteItem: AccountVaultItem = {
      scope: "all",
      kind: "linear_refresh_token",
      key: "default",
      value: "remote-refresh-token",
      updatedAt: "2026-09-17T12:00:00.000Z",
      writerDeviceId: "other-device",
      refreshOwner: null,
    };
    const setup = makeLifecycleArgs();
    const relay = makeRelay([remoteItem]);
    const events: string[] = [];
    relay.getAccountVault = vi.fn(async () => {
      events.push("vault-pull");
      return { items: [remoteItem], cursor: null, truncated: false };
    });
    setup.context.linearCredentialService = {
      getRefreshToken: () => "stale-local-refresh-token",
      getRefreshTokenProvenance: () => ({ source: "device", accountUserId: null }),
      hydrateFromVault: vi.fn(async () => {
        events.push("hydrate");
      }),
      purgeAccountCredentials: vi.fn(),
    };
    const lifecycle = createAccountRuntimeLifecycle({
      ...setup.args,
      relay,
    });

    try {
      await lifecycle.initialize();
      await vi.waitFor(() => expect(setup.context.linearCredentialService?.hydrateFromVault).toHaveBeenCalledOnce());

      expect(events.indexOf("vault-pull")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("hydrate")).toBeGreaterThan(events.indexOf("vault-pull"));
      expect(relay.putAccountVault).not.toHaveBeenCalled();
    } finally {
      setup.cleanup();
    }
  });

  it("A4: purges account-origin credentials on sign-out without sync", () => {
    const accountKeys = new Map([
      ["account-origin", "account-value"],
      ["device-only", "device-value"],
    ]);
    const setup = makeLifecycleArgs({
      enabled: false,
      purgeAccountApiKeys: vi.fn(() => accountKeys.delete("account-origin")),
    });
    const lifecycle = createAccountRuntimeLifecycle(setup.args);

    try {
      expect(lifecycle.accountVaultStore).toBeNull();
      setup.auth.emitSignedOut();

      expect(setup.args.purgeAccountApiKeys).toHaveBeenCalledOnce();
      expect(accountKeys.get("account-origin")).toBeUndefined();
      expect(accountKeys.get("device-only")).toBe("device-value");
      expect(setup.context.projectSecretService?.purgeAccountCredentials).toHaveBeenCalledOnce();
      expect(setup.context.linearCredentialService?.purgeAccountCredentials).toHaveBeenCalledOnce();
    } finally {
      setup.cleanup();
    }
  });
});
