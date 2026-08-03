// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/platform", async () => {
  const actual = await vi.importActual<typeof import("../../lib/platform")>("../../lib/platform");
  return {
    ...actual,
    supportsNativeNotch: false,
  };
});

import { DEFAULT_ATTENTION_PREFERENCES } from "../../../shared/types";
import { publishAccountStatus, SIGNED_OUT_ACCOUNT } from "../../lib/account";
import { resetActivityStoreForTests } from "../../state/activityStore";
import { ActivitySettingsPopover } from "./ActivitySettingsPopover";

const originalAde = window.ade;
const signedInAccount = {
  signedIn: true as const,
  userId: "account-windows",
  email: null,
  name: null,
  expiresAt: null,
  provider: null,
  imageUrl: null,
};

describe("ActivitySettingsPopover on Windows", () => {
  const getPreferences = vi.fn(async () => DEFAULT_ATTENTION_PREFERENCES);
  const putPreferences = vi.fn(async () => undefined);
  const updateNotchSettings = vi.fn(async () => undefined);

  beforeEach(() => {
    window.localStorage.clear();
    getPreferences.mockClear();
    putPreferences.mockClear();
    updateNotchSettings.mockClear();
    publishAccountStatus(signedInAccount);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        ...(originalAde ?? {}),
        account: {
          ...(originalAde?.account ?? {}),
          status: vi.fn(async () => signedInAccount),
        },
        attention: {
          getPreferences,
          putPreferences,
        },
        // The preload namespace may exist cross-platform. Platform capability,
        // not property presence, decides whether native notch behavior runs.
        attentionNotch: {
          updateSettings: updateNotchSettings,
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    resetActivityStoreForTests();
    publishAccountStatus(SIGNED_OUT_ACCOUNT);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: originalAde,
    });
  });

  it("hides notch controls and saves account delivery without calling the native bridge", async () => {
    render(<ActivitySettingsPopover />);

    fireEvent.click(screen.getByRole("button", { name: "Activity settings" }));
    await screen.findByRole("dialog", { name: "Activity settings" });
    await waitFor(() => expect(getPreferences).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole("switch", { name: "ADE notch" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Notch behavior" })).toBeNull();
    expect(screen.getByText("Account delivery preferences")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Activity sounds" })).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Activity sounds" }));

    await waitFor(() => expect(putPreferences).toHaveBeenCalledTimes(1));
    expect(updateNotchSettings).not.toHaveBeenCalled();
  });
});
