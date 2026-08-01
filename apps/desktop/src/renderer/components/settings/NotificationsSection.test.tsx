/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_ATTENTION_PREFERENCES } from "../../../shared/types/attention";
import { NotificationsSection } from "./NotificationsSection";
import { settingsEntriesForTab } from "./settingsManifest";

vi.mock("../../lib/account", () => ({
  useAccountStatus: () => ({ status: { signedIn: true, userId: "user-1" } }),
}));

function installAdeMock() {
  const putPreferences = vi.fn(async (_ownerId: string, _prefs: any) => {});
  const getPreferences = vi.fn(async () => DEFAULT_ATTENTION_PREFERENCES);
  const updateSettings = vi.fn(async (_settings: any) => {});
  const saveProjectConfig = vi.fn(async (_candidate: any) => {});
  (window as any).ade = {
    attention: { getPreferences, putPreferences },
    attentionNotch: { updateSettings },
    projectConfig: {
      get: vi.fn(async () => ({
        shared: {},
        local: {},
        effective: { git: { laneBannerBudget: 2 } },
      })),
      save: saveProjectConfig,
    },
  };
  return { getPreferences, putPreferences, updateSettings, saveProjectConfig };
}

afterEach(() => {
  cleanup();
  delete (window as any).ade;
});

describe("NotificationsSection", () => {
  it("renders every anchor the settings manifest promises for this tab", async () => {
    installAdeMock();
    const { container } = render(<NotificationsSection />);
    await screen.findByText("Notify me about");

    // A manifest entry whose anchor is never rendered is an invisible break:
    // Cmd-K offers the setting, navigates, and lands on nothing.
    const rendered = new Set(
      [...container.querySelectorAll("[data-settings-anchor]")]
        .map((node) => node.getAttribute("data-settings-anchor")),
    );
    for (const entry of settingsEntriesForTab("notifications")) {
      expect(rendered, `manifest promises #${entry.anchor} but nothing renders it`).toContain(entry.anchor);
    }
  });

  it("exposes a per-event policy control for each event and saves the change", async () => {
    const { putPreferences } = installAdeMock();
    render(<NotificationsSection />);
    await screen.findByText("Notify me about");

    // The delivery model shipped with these policies but no UI ever exposed
    // them; this is the control that makes them reachable.
    const group = screen.getByRole("radiogroup", { name: "CI fails" });
    expect(group).toBeTruthy();

    fireEvent.click(within(group).getByRole("radio", { name: /Ambient/ }));

    await waitFor(() => expect(putPreferences).toHaveBeenCalledTimes(1));
    const saved = putPreferences.mock.calls[0]![1];
    expect(saved.account.eventPolicies.pr_checks_failing).toBe("ambient");
    // Other events must be untouched by a single-row edit.
    expect(saved.account.eventPolicies.agent_needs_you)
      .toBe(DEFAULT_ATTENTION_PREFERENCES.account.eventPolicies.agent_needs_you);
  });

  it("saves without a Save button", async () => {
    const { putPreferences } = installAdeMock();
    render(<NotificationsSection />);
    await screen.findByText("Notify me about");

    expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Phone notifications" }));
    await waitFor(() => expect(putPreferences).toHaveBeenCalledTimes(1));
    expect(putPreferences.mock.calls[0]![1].account.notificationsEnabled).toBe(false);
  });

  it("pushes notch presentation to the notch process without touching synced prefs", async () => {
    const { putPreferences, updateSettings } = installAdeMock();
    render(<NotificationsSection />);
    await screen.findByText("Notify me about");

    fireEvent.click(screen.getByRole("switch", { name: "Celebrations" }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(putPreferences).toHaveBeenCalledTimes(1);
    expect(updateSettings.mock.calls[0]![0].celebrationsEnabled).toBe(false);
  });

  it("reveals quiet-hour times only once quiet hours are on", async () => {
    installAdeMock();
    render(<NotificationsSection />);
    await screen.findByText("Notify me about");

    expect(screen.queryByLabelText("From")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
    expect(await screen.findByLabelText("From")).toBeTruthy();
  });
  it("keeps notch presentation on this Mac and pushes it to the native helper", async () => {
    const { putPreferences, updateSettings } = installAdeMock();
    render(<NotificationsSection />);
    await screen.findByText("Notify me about");

    // Moved here from the header popover: reveal mode and the expanded panel
    // are machine-local, so they must reach the notch process and localStorage
    // without being written into the synced account preferences.
    const behavior = await screen.findByRole("combobox", { name: "Notch behavior" });
    fireEvent.change(behavior, { target: { value: "click" } });

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const pushed = updateSettings.mock.calls.at(-1)![0];
    expect(pushed.revealMode).toBe("click");
    expect(window.localStorage.getItem("ade:attention:notch-reveal-mode")).toBe("click");
    // The synced payload carries no notch presentation.
    expect(putPreferences.mock.calls.at(-1)![1]).not.toHaveProperty("revealMode");
  });

  it("hides notch presentation controls while the notch is off", async () => {
    installAdeMock();
    render(<NotificationsSection />);
    await screen.findByText("Notify me about");

    expect(screen.queryByRole("combobox", { name: "Notch behavior" })).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "ADE notch" }));
    await waitFor(() => {
      expect(screen.queryByRole("combobox", { name: "Notch behavior" })).toBeNull();
    });
  });
});
