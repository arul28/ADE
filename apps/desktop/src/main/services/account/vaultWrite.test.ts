import { describe, expect, it, vi } from "vitest";
import {
  fireAndForgetVaultWrite,
  VAULT_WRITE_MAX_ATTEMPTS,
} from "./vaultWrite";
import type { AccountVaultBridge } from "./accountVaultBridge";

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("fireAndForgetVaultWrite", () => {
  it("retries a failed write against a re-resolved vault and stops on success", async () => {
    const scheduled: Array<() => void> = [];
    const first = { ok: false as const, unavailable: true as const, message: "down" };
    const second = { ok: true as const, value: null };
    const set = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const getAccountVault = vi.fn(() => ({ set }) as unknown as AccountVaultBridge);
    const warn = vi.fn();

    fireAndForgetVaultWrite(
      {
        getAccountVault,
        logger: { warn },
        logEvent: "vault.write_failed",
        schedule: (callback) => {
          scheduled.push(callback);
        },
      },
      "set",
      (vault) => vault.set("all", "provider_api_key", "claude", "sk-test"),
    );

    await settle();
    expect(set).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(1);

    scheduled[0]?.();
    await settle();
    expect(set).toHaveBeenCalledTimes(2);
    expect(getAccountVault).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(1);
  });

  it("gives up after the bounded attempts when the vault stays unavailable", async () => {
    const scheduled: Array<() => void> = [];
    const getAccountVault = vi.fn(() => null);
    const warn = vi.fn();

    fireAndForgetVaultWrite(
      {
        getAccountVault,
        logger: { warn },
        logEvent: "vault.write_failed",
        schedule: (callback) => {
          scheduled.push(callback);
        },
      },
      "remove",
      (vault) => vault.remove("all", "provider_api_key", "claude"),
    );

    expect(getAccountVault).toHaveBeenCalledOnce();
    for (let remaining = VAULT_WRITE_MAX_ATTEMPTS - 1; remaining > 0; remaining -= 1) {
      expect(scheduled).toHaveLength(VAULT_WRITE_MAX_ATTEMPTS - remaining);
      scheduled.at(-1)?.();
    }
    expect(getAccountVault).toHaveBeenCalledTimes(VAULT_WRITE_MAX_ATTEMPTS);
    expect(warn).toHaveBeenCalledTimes(VAULT_WRITE_MAX_ATTEMPTS);
    expect(scheduled).toHaveLength(VAULT_WRITE_MAX_ATTEMPTS - 1);
  });
});
