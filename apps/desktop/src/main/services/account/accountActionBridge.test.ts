import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_SETTINGS_REJECTED_MESSAGE,
  ACCOUNT_SETTINGS_UNAVAILABLE_MESSAGE,
  createAccountSettingsSyncService,
} from "./accountSettingsSync";
import {
  ACCOUNT_VAULT_REJECTED_MESSAGE,
  ACCOUNT_VAULT_UNAVAILABLE_MESSAGE,
  createAccountVaultBridge,
} from "./accountVaultBridge";

function poolReturning(result: unknown) {
  return {
    callActionForRoot: vi.fn(async () => ({ result })),
  };
}

describe("accountSettingsSync (main)", () => {
  it("answers unavailable instead of throwing when there is no runtime pool", async () => {
    const service = createAccountSettingsSyncService({
      getPool: () => null,
      getRootPath: () => "/repo",
    });
    for (const result of [
      await service.list(),
      await service.get("all", "theme"),
      await service.set("all", "theme", "light"),
      await service.remove("all", "theme"),
      await service.sync(),
    ]) {
      expect(result).toEqual({
        ok: false,
        unavailable: true,
        message: ACCOUNT_SETTINGS_UNAVAILABLE_MESSAGE,
      });
    }
  });

  it("answers unavailable when no project scope is booted yet", async () => {
    const pool = poolReturning([]);
    const service = createAccountSettingsSyncService({
      getPool: () => pool,
      getRootPath: () => null,
    });
    expect(await service.list()).toMatchObject({ ok: false, unavailable: true });
    expect(pool.callActionForRoot).not.toHaveBeenCalled();
  });

  it("calls the account_settings domain with positional args", async () => {
    const pool = poolReturning({ domain: "account_settings", action: "set", result: undefined });
    const service = createAccountSettingsSyncService({
      getPool: () => pool,
      getRootPath: () => "/repo",
    });
    await service.set("repo:github.com/ade/ade", "chatChromeTint", "plain");
    expect(pool.callActionForRoot).toHaveBeenCalledWith("/repo", {
      domain: "account_settings",
      action: "set",
      argsList: ["repo:github.com/ade/ade", "chatChromeTint", "plain"],
    });

    await service.list("all");
    expect(pool.callActionForRoot).toHaveBeenLastCalledWith("/repo", {
      domain: "account_settings",
      action: "list",
      argsList: ["all"],
    });

    await service.sync();
    expect(pool.callActionForRoot).toHaveBeenLastCalledWith("/repo", {
      domain: "account_settings",
      action: "sync",
      argsList: [],
    });
  });

  it("A1: forwards the expected owner through settings mutation args", async () => {
    const pool = poolReturning({ domain: "account_settings", action: "set", result: undefined });
    const service = createAccountSettingsSyncService({
      getPool: () => pool,
      getRootPath: () => "/repo",
    });

    await service.set("all", "theme", "light", { expectedAccountUserId: "user-ada" });
    expect(pool.callActionForRoot).toHaveBeenLastCalledWith("/repo", {
      domain: "account_settings",
      action: "set",
      argsList: ["all", "theme", "light", { expectedAccountUserId: "user-ada" }],
    });

    await service.remove("all", "theme", { expectedAccountUserId: "user-ada" });
    expect(pool.callActionForRoot).toHaveBeenLastCalledWith("/repo", {
      domain: "account_settings",
      action: "remove",
      argsList: ["all", "theme", { expectedAccountUserId: "user-ada" }],
    });
  });

  it("A2: distinguishes a rejected write from an unavailable runtime", async () => {
    const service = createAccountSettingsSyncService({
      getPool: () => poolReturning({ domain: "account_settings", action: "set", result: false }),
      getRootPath: () => "/repo",
    });

    expect(await service.set("all", "theme", "light")).toEqual({
      ok: false,
      rejected: true,
      message: ACCOUNT_SETTINGS_REJECTED_MESSAGE,
    });
    expect(await service.remove("all", "theme")).toEqual({
      ok: false,
      rejected: true,
      message: ACCOUNT_SETTINGS_REJECTED_MESSAGE,
    });
  });

  it("unwraps the brain envelope and drops malformed rows", async () => {
    const pool = poolReturning({
      domain: "account_settings",
      action: "list",
      result: [
        { scope: "all", key: "theme", value: "light", updatedAt: "2026-01-01T00:00:00.000Z", changedAt: null, writerDeviceId: null },
        { scope: "all", key: "broken" },
        "nonsense",
      ],
    });
    const service = createAccountSettingsSyncService({
      getPool: () => pool,
      getRootPath: () => "/repo",
    });
    const result = await service.list("all");
    expect(result).toEqual({
      ok: true,
      value: [
        {
          scope: "all",
          key: "theme",
          value: "light",
          updatedAt: "2026-01-01T00:00:00.000Z",
          changedAt: null,
          writerDeviceId: null,
        },
      ],
    });
  });

  it("turns a brain failure into an unavailable result carrying its message", async () => {
    const debug = vi.fn();
    const service = createAccountSettingsSyncService({
      getPool: () => ({
        callActionForRoot: vi.fn(async () => {
          throw new Error("connection closed");
        }),
      }),
      getRootPath: () => "/repo",
      logger: { debug },
    });
    expect(await service.get("all", "theme")).toEqual({
      ok: false,
      unavailable: true,
      message: "connection closed",
    });
    expect(debug).toHaveBeenCalledWith("account_settings.call_failed", {
      action: "get",
      error: "connection closed",
    });
  });
});

function poolReturningVault(result: unknown) {
  return {
    callActionForRoot: vi.fn(async () => ({ result })),
  };
}

describe("accountVaultBridge (main)", () => {
  it("answers unavailable instead of throwing when there is no runtime pool", async () => {
    const bridge = createAccountVaultBridge({
      getPool: () => null,
      getRootPath: () => "/repo",
    });
    for (const result of [
      await bridge.list(),
      await bridge.get("all", "secret", "token"),
      await bridge.set("all", "secret", "token", "value"),
      await bridge.remove("all", "secret", "token"),
      await bridge.sync(),
    ]) {
      expect(result).toEqual({
        ok: false,
        unavailable: true,
        message: ACCOUNT_VAULT_UNAVAILABLE_MESSAGE,
      });
    }
  });

  it("answers unavailable when no project scope is booted yet", async () => {
    const pool = poolReturningVault([]);
    const bridge = createAccountVaultBridge({
      getPool: () => pool,
      getRootPath: () => null,
    });
    expect(await bridge.list()).toMatchObject({ ok: false, unavailable: true });
    expect(pool.callActionForRoot).not.toHaveBeenCalled();
  });

  it("calls the account_vault domain with positional args", async () => {
    const pool = poolReturningVault({ domain: "account_vault", action: "set", result: undefined });
    const bridge = createAccountVaultBridge({
      getPool: () => pool,
      getRootPath: () => "/repo",
    });
    await bridge.set("all", "provider_key", "anthropic", "token");
    expect(pool.callActionForRoot).toHaveBeenCalledWith("/repo", {
      domain: "account_vault",
      action: "set",
      argsList: ["all", "provider_key", "anthropic", "token"],
    });

    await bridge.list("all");
    expect(pool.callActionForRoot).toHaveBeenLastCalledWith("/repo", {
      domain: "account_vault",
      action: "list",
      argsList: ["all"],
    });

    await bridge.get("all", "provider_key", "anthropic");
    expect(pool.callActionForRoot).toHaveBeenLastCalledWith("/repo", {
      domain: "account_vault",
      action: "get",
      argsList: ["all", "provider_key", "anthropic"],
    });

    await bridge.remove("all", "provider_key", "anthropic");
    expect(pool.callActionForRoot).toHaveBeenLastCalledWith("/repo", {
      domain: "account_vault",
      action: "remove",
      argsList: ["all", "provider_key", "anthropic"],
    });

    await bridge.sync();
    expect(pool.callActionForRoot).toHaveBeenLastCalledWith("/repo", {
      domain: "account_vault",
      action: "sync",
      argsList: [],
    });
  });

  it("A1: forwards the expected owner through vault mutation args", async () => {
    const pool = poolReturningVault({ domain: "account_vault", action: "set", result: undefined });
    const bridge = createAccountVaultBridge({
      getPool: () => pool,
      getRootPath: () => "/repo",
    });

    await bridge.set("all", "provider_key", "anthropic", "token", {
      expectedAccountUserId: "user-ada",
    });
    expect(pool.callActionForRoot).toHaveBeenLastCalledWith("/repo", {
      domain: "account_vault",
      action: "set",
      argsList: ["all", "provider_key", "anthropic", "token", { expectedAccountUserId: "user-ada" }],
    });

    await bridge.remove("all", "provider_key", "anthropic", {
      expectedAccountUserId: "user-ada",
    });
    expect(pool.callActionForRoot).toHaveBeenLastCalledWith("/repo", {
      domain: "account_vault",
      action: "remove",
      argsList: ["all", "provider_key", "anthropic", { expectedAccountUserId: "user-ada" }],
    });
  });

  it("A2: distinguishes a rejected write from an unavailable runtime", async () => {
    const bridge = createAccountVaultBridge({
      getPool: () => poolReturningVault({ domain: "account_vault", action: "set", result: false }),
      getRootPath: () => "/repo",
    });

    expect(await bridge.set("all", "secret", "token", "value")).toEqual({
      ok: false,
      rejected: true,
      message: ACCOUNT_VAULT_REJECTED_MESSAGE,
    });
    expect(await bridge.remove("all", "secret", "token")).toEqual({
      ok: false,
      rejected: true,
      message: ACCOUNT_VAULT_REJECTED_MESSAGE,
    });
  });

  it("unwraps the brain envelope and drops malformed items", async () => {
    const pool = poolReturningVault({
      domain: "account_vault",
      action: "list",
      result: [
        {
          scope: "all",
          kind: "provider_key",
          key: "anthropic",
          value: "token",
          updatedAt: "2026-01-01T00:00:00.000Z",
          writerDeviceId: "device-1",
          refreshOwner: null,
        },
        { scope: "all", kind: "secret", key: "broken", value: 42, updatedAt: "now" },
        "nonsense",
      ],
    });
    const bridge = createAccountVaultBridge({
      getPool: () => pool,
      getRootPath: () => "/repo",
    });
    expect(await bridge.list("all")).toEqual({
      ok: true,
      value: [
        {
          scope: "all",
          kind: "provider_key",
          key: "anthropic",
          value: "token",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("keeps redacted list rows so callers can fetch their values", async () => {
    const pool = poolReturningVault({
      domain: "account_vault",
      action: "list",
      result: [
        {
          scope: "all",
          kind: "provider_api_key",
          key: "openai",
          updatedAt: "now",
          readable: true,
        },
      ],
    });
    const bridge = createAccountVaultBridge({
      getPool: () => pool,
      getRootPath: () => "/repo",
    });

    expect(await bridge.list("all")).toEqual({
      ok: true,
      value: [
        {
          scope: "all",
          kind: "provider_api_key",
          key: "openai",
          value: null,
          updatedAt: "now",
        },
      ],
    });
  });

  it("turns a brain failure into an unavailable result carrying its message", async () => {
    const debug = vi.fn();
    const bridge = createAccountVaultBridge({
      getPool: () => ({
        callActionForRoot: vi.fn(async () => {
          throw new Error("connection closed");
        }),
      }),
      getRootPath: () => "/repo",
      logger: { debug },
    });
    expect(await bridge.get("all", "secret", "token")).toEqual({
      ok: false,
      unavailable: true,
      message: "connection closed",
    });
    expect(debug).toHaveBeenCalledWith("account_vault.call_failed", {
      action: "get",
      error: "connection closed",
    });
  });
});
