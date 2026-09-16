import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_SETTINGS_UNAVAILABLE_MESSAGE,
  createAccountSettingsSyncService,
} from "./accountSettingsSync";

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
