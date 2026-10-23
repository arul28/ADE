// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ATTENTION_PREFERENCES } from "../../../shared/types";
import { publishAccountStatus, SIGNED_OUT_ACCOUNT } from "../../lib/account";
import { useActivitySettings } from "./ActivitySettingsControls";

const originalAde = window.ade;

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
    const signedIn = {
      signedIn: true,
      userId: "user-settings",
      email: null,
      name: null,
      expiresAt: null,
      provider: null,
      imageUrl: null,
    } satisfies Parameters<typeof publishAccountStatus>[0];
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(originalAde ?? {}),
        attention: { getPreferences, putPreferences },
        account: { ...(originalAde?.account ?? {}), status: vi.fn(async () => signedIn) },
      },
    });
    publishAccountStatus(signedIn);

    const { result } = renderHook(() => useActivitySettings());
    await waitFor(() => expect(getPreferences).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The defaults the hook holds are not the account's: every control is
    // read-only, and a change that slips through is not sent.
    expect(result.current.busy).toBe(true);
    act(() => result.current.updateAccount({ hideDetails: !DEFAULT_ATTENTION_PREFERENCES.account.hideDetails }));
    expect(putPreferences).not.toHaveBeenCalled();

    // Try again reads once more and unlocks on a real answer.
    getPreferences.mockResolvedValueOnce(DEFAULT_ATTENTION_PREFERENCES as never);
    act(() => result.current.retryLoad());
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(getPreferences).toHaveBeenCalledTimes(2);
  });
});
