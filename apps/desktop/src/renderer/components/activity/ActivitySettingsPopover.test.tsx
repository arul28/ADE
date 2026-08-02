// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/platform", async () => {
  const actual = await vi.importActual<typeof import("../../lib/platform")>("../../lib/platform");
  return {
    ...actual,
    supportsNativeNotch: true,
  };
});

import { DEFAULT_ATTENTION_PREFERENCES } from "../../../shared/types";
import { publishAccountStatus, SIGNED_OUT_ACCOUNT } from "../../lib/account";
import { resetActivityStoreForTests } from "../../state/activityStore";
import { ActivitySettingsPopover } from "./ActivitySettingsPopover";

const originalAde = window.ade;
const signedInAccount = {
  signedIn: true as const,
  userId: "account-a",
  email: null,
  name: null,
  expiresAt: null,
  provider: null,
  imageUrl: null,
};

function installAde() {
  const putPreferences = vi.fn(async () => undefined);
  const updateSettings = vi.fn(async () => undefined);
  Object.defineProperty(window, "ade", {
    configurable: true,
    writable: true,
    value: {
      ...(originalAde ?? {}),
      account: { status: vi.fn(async () => signedInAccount) },
      attention: {
        getSnapshot: vi.fn(),
        acknowledge: vi.fn(),
        reportPresence: vi.fn(),
        getPreferences: vi.fn(async () => DEFAULT_ATTENTION_PREFERENCES),
        putPreferences,
      },
      attentionNotch: { updateSettings, publishSnapshot: vi.fn() },
    },
  });
  return { putPreferences, updateSettings };
}

beforeEach(() => {
  window.localStorage.clear();
  publishAccountStatus(signedInAccount);
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

describe("ActivitySettingsPopover", () => {
  it("saves as you go, with no Save button to forget", async () => {
    const { putPreferences, updateSettings } = installAde();
    render(<ActivitySettingsPopover />);

    fireEvent.click(screen.getByRole("button", { name: "Activity settings" }));
    await screen.findByRole("dialog", { name: "Activity settings" });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Activity sounds" })).toBeTruthy());

    expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Activity sounds" }));

    await waitFor(() => {
      expect(putPreferences).toHaveBeenCalledWith(
        "account-a",
        expect.objectContaining({
          account: expect.objectContaining({ soundsEnabled: true }),
        }),
      );
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ soundsEnabled: true }),
      );
    });
  });

  it("keeps the notch enabled flag on this Mac while syncing its presentation", async () => {
    const { putPreferences, updateSettings } = installAde();
    render(<ActivitySettingsPopover />);

    fireEvent.click(screen.getByRole("button", { name: "Activity settings" }));
    await screen.findByRole("dialog", { name: "Activity settings" });
    await waitFor(() => expect(screen.getByRole("switch", { name: "ADE notch" })).toBeTruthy());

    fireEvent.click(screen.getByRole("switch", { name: "ADE notch" }));
    await waitFor(() => {
      expect(window.localStorage.getItem("ade:attention:notch-enabled")).toBe("false");
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    });
    // Whether this Mac shows a notch at all is this Mac's business.
    const [, savedPreferences] = putPreferences.mock.calls.at(-1) as unknown as [
      string,
      { account: Record<string, unknown> },
    ];
    expect(savedPreferences.account).not.toHaveProperty("notchEnabled");
  });

  it("returns focus to the trigger when Escape dismisses it", async () => {
    installAde();
    render(<ActivitySettingsPopover />);
    const trigger = screen.getByRole("button", { name: "Activity settings" });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Activity settings" });
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Activity settings" })).toBeNull();
    });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("links to Settings through the navigation bus, not the router", async () => {
    // Activity mounts outside the router here (and in the notch), so the link
    // must dispatch an app-navigation target rather than calling useNavigate —
    // which would throw "may be used only in the context of a <Router>".
    installAde();
    const targets: unknown[] = [];
    const onNavigate = (event: Event) => {
      targets.push((event as CustomEvent).detail?.target);
    };
    window.addEventListener("ade:navigate-target", onNavigate);
    try {
      render(<ActivitySettingsPopover />);
      fireEvent.click(screen.getByRole("button", { name: "Activity settings" }));
      await screen.findByRole("dialog", { name: "Activity settings" });

      fireEvent.click(await screen.findByRole("button", { name: /All Activity settings/ }));

      expect(targets).toEqual([{ kind: "settings", tab: "activity" }]);
    } finally {
      window.removeEventListener("ade:navigate-target", onNavigate);
    }
  });
});
