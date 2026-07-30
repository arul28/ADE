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
import {
  publishAccountStatus,
  SIGNED_OUT_ACCOUNT,
} from "../../lib/account";
import { AttentionSettingsPopover } from "./AttentionSettingsPopover";

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

describe("AttentionSettingsPopover on Windows", () => {
  const getPreferences = vi.fn(async () => DEFAULT_ATTENTION_PREFERENCES);
  const putPreferences = vi.fn(async () => DEFAULT_ATTENTION_PREFERENCES);
  const updateNotchSettings = vi.fn(async () => undefined);

  beforeEach(() => {
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
        attentionNotch: {
          updateSettings: updateNotchSettings,
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    publishAccountStatus(SIGNED_OUT_ACCOUNT);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: originalAde,
    });
  });

  it("hides Notch controls and saves account delivery without calling the native bridge", async () => {
    render(<AttentionSettingsPopover />);

    fireEvent.click(screen.getByRole("button", { name: "Attention settings" }));
    await screen.findByRole("dialog", { name: "Attention settings" });
    await waitFor(() => expect(getPreferences).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole("switch", { name: "ADE Notch" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Notch behavior" })).toBeNull();
    expect(screen.getByText("Account delivery preferences")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Phone notifications" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putPreferences).toHaveBeenCalledTimes(1));
    expect(updateNotchSettings).not.toHaveBeenCalled();
  });
});
