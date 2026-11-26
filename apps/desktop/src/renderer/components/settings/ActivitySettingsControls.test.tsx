// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ATTENTION_PREFERENCES } from "../../../shared/types";
import { publishAccountStatus, SIGNED_OUT_ACCOUNT } from "../../lib/account";
import { useActivitySettings } from "./ActivitySettingsControls";

const originalAde = window.ade;
const signedIn = {
  signedIn: true,
  userId: "user-settings",
  email: null,
  name: null,
  expiresAt: null,
  provider: null,
  imageUrl: null,
} satisfies Parameters<typeof publishAccountStatus>[0];

function installSettingsApi(attention: Pick<typeof window.ade.attention, "getPreferences" | "putPreferences"> & Partial<Pick<typeof window.ade.attention, "putDevicePreferences">>) {
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: {
      ...(originalAde ?? {}),
      attention,
      account: { ...(originalAde?.account ?? {}), status: vi.fn(async () => signedIn) },
    },
  });
  publishAccountStatus(signedIn);
}

afterEach(() => {
  cleanup();
  publishAccountStatus(SIGNED_OUT_ACCOUNT);
  Object.defineProperty(window, "ade", { configurable: true, writable: true, value: originalAde });
});

describe("useActivitySettings", () => {
  it.each([
    { name: "the account service is unreachable (null)", read: async () => null },
    { name: "the read fails", read: async () => { throw new Error("relay refused"); } },
  ])("never saves defaults over the account's settings when $name", async ({ read }) => {
    const getPreferences = vi.fn(read);
    const putPreferences = vi.fn(async () => undefined);
    installSettingsApi({ getPreferences, putPreferences });

    const { result } = renderHook(() => useActivitySettings());
    await waitFor(() => expect(getPreferences).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The defaults the hook holds are not the account's: every control is
    // read-only, and a change that slips through is not sent.
    expect(result.current.busy).toBe(true);
    await act(async () => {
      await result.current.updateAccount({ hideDetails: !DEFAULT_ATTENTION_PREFERENCES.account.hideDetails });
    });
    expect(putPreferences).not.toHaveBeenCalled();

    // Try again reads once more and unlocks on a real answer.
    getPreferences.mockResolvedValueOnce(DEFAULT_ATTENTION_PREFERENCES as never);
    act(() => result.current.retryLoad());
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(getPreferences).toHaveBeenCalledTimes(2);
  });

  it("restores a refused account setting even if a phone save succeeds afterward", async () => {
    let rejectAccount!: (error: Error) => void;
    let finishPhone!: () => void;
    const accountWrite = new Promise<void>((_resolve, reject) => { rejectAccount = reject; });
    const phoneWrite = new Promise<void>((resolve) => { finishPhone = resolve; });
    const preferences = {
      ...DEFAULT_ATTENTION_PREFERENCES,
      account: { ...DEFAULT_ATTENTION_PREFERENCES.account, notificationsEnabled: true },
    };
    const putPreferences = vi.fn().mockReturnValueOnce(accountWrite).mockResolvedValue(undefined);
    installSettingsApi({
      getPreferences: async () => preferences,
      putPreferences,
      putDevicePreferences: async () => await phoneWrite,
    });

    const { result } = renderHook(() => useActivitySettings());
    await waitFor(() => expect(result.current.busy).toBe(false));
    act(() => {
      void result.current.setPhoneNotificationsEnabled("phone-1", false);
      void result.current.updateAccount({ notificationsEnabled: false });
      void result.current.updateAccount({ hideDetails: true });
    });
    expect(result.current.account.notificationsEnabled).toBe(false);
    expect(result.current.accountBusy).toBe(true);
    expect(putPreferences).toHaveBeenCalledTimes(1);

    await act(async () => { rejectAccount(new Error("Account save refused")); });
    await act(async () => { finishPhone(); });
    expect(result.current.account.notificationsEnabled).toBe(true);
    expect(result.current.phoneNotificationsEnabled("phone-1")).toBe(false);
    expect(result.current.error).toBe("Account save refused");
    expect(result.current.saved).toBe(false);
    expect(result.current.accountBusy).toBe(false);

    await act(async () => { await result.current.updateAccount({ notificationsEnabled: false }); });
    expect(result.current.account.notificationsEnabled).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.saved).toBe(true);
  });
});
