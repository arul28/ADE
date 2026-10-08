// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function installAde(saved: unknown = DEFAULT_ATTENTION_PREFERENCES) {
  const putPreferences = vi.fn(async () => undefined);
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
        getPreferences: vi.fn(async () => saved),
        putPreferences,
      },
    },
  });
  return { putPreferences };
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
    const { putPreferences } = installAde();
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
    });
  });

  it("saves preferences from an older build onto the current defaults", async () => {
    // Every save writes the whole policy map, so "notify" for merge-ready, saved
    // when that was the default, is the old default and not a choice. The
    // removed notch's synced fields stop travelling too.
    const { eventPolicyDefaultsVersion: _version, ...olderAccount } = DEFAULT_ATTENTION_PREFERENCES.account;
    const { putPreferences } = installAde({
      ...DEFAULT_ATTENTION_PREFERENCES,
      account: {
        ...olderAccount,
        eventPolicies: {
          ...DEFAULT_ATTENTION_PREFERENCES.account.eventPolicies,
          pr_merge_ready: "notify",
          pr_review_requested: "notify",
          agent_completed: "notify",
        },
        notchRevealMode: "always",
        notchExpandedPanel: true,
      },
    });
    render(<ActivitySettingsPopover />);
    fireEvent.click(screen.getByRole("button", { name: "Activity settings" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Activity sounds" })).toBeTruthy());
    fireEvent.click(screen.getByRole("switch", { name: "Activity sounds" }));

    await waitFor(() => expect(putPreferences).toHaveBeenCalled());
    const [, savedPreferences] = putPreferences.mock.calls.at(-1) as unknown as [
      string,
      { account: Record<string, unknown> & { eventPolicies: Record<string, string> } },
    ];
    expect(savedPreferences.account.eventPolicyDefaultsVersion).toBe(2);
    expect(savedPreferences.account.eventPolicies.pr_merge_ready).toBe("ambient");
    expect(savedPreferences.account.eventPolicies.pr_review_requested).toBe("ambient");
    // A notify that was never a default is the user's own choice and stays.
    expect(savedPreferences.account.eventPolicies.agent_completed).toBe("notify");
    expect(savedPreferences.account).not.toHaveProperty("notchRevealMode");
    expect(savedPreferences.account).not.toHaveProperty("notchExpandedPanel");
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
    // Activity mounts outside the router here, so the link
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

      expect(targets).toEqual([{ kind: "settings", tab: "notifications" }]);
    } finally {
      window.removeEventListener("ade:navigate-target", onNavigate);
    }
  });
});
