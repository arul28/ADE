/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../lib/platform", async () => {
  const actual = await vi.importActual<typeof import("../../lib/platform")>("../../lib/platform");
  return {
    ...actual,
    supportsNativeNotch: true,
  };
});

import {
  ATTENTION_CONTRACT_VERSION,
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionItem,
} from "../../../shared/types/attention";
import {
  activityStore,
  resetActivityStoreForTests,
} from "../../state/activityStore";
import { ActivitySection } from "./ActivitySection";
import { settingsEntriesForTab } from "./settingsManifest";

vi.mock("../../lib/account", () => ({
  useAccountStatus: () => ({ status: { signedIn: true, userId: "user-1" } }),
}));

function installAdeMock() {
  const getPreferences = vi.fn(async () => DEFAULT_ATTENTION_PREFERENCES);
  const putPreferences = vi.fn(async (_ownerId: string, _prefs: unknown) => {});
  const putMachinePreferences = vi.fn(
    async (_ownerId: string, _machineKey: string, _partial: unknown) => {},
  );
  const updateSettings = vi.fn(async (_settings: unknown) => {});
  (window as unknown as { ade: unknown }).ade = {
    attention: { getPreferences, putPreferences, putMachinePreferences },
    attentionNotch: { updateSettings },
  };
  return { getPreferences, putPreferences, putMachinePreferences, updateSettings };
}

function machineItem(machineKey: string, name: string, online = true): AttentionItem {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    id: `item-${machineKey}`,
    revision: 1,
    fingerprint: `fingerprint-${machineKey}`,
    kind: "agent",
    eventKind: "agent_running",
    phase: "running",
    machine: { machineKey, name, online, lastSeenAt: null },
    project: { projectId: "ade", name: "ADE", rootPath: "/repo/ade" },
    title: `Task on ${name}`,
    preview: "",
    privacyPreview: "",
    destination: { kind: "session", sessionId: `session-${machineKey}` },
    actions: [],
    occurredAt: "2026-07-28T14:00:00.000Z",
    updatedAt: "2026-07-28T14:00:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  resetActivityStoreForTests();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("ActivitySection", () => {
  it("renders every anchor the settings manifest promises for this tab", async () => {
    installAdeMock();
    const { container } = render(<ActivitySection />);
    await screen.findByText("ADE notch");

    // A manifest entry whose anchor is never rendered is an invisible break:
    // Cmd-K offers the setting, navigates, and lands on nothing.
    const rendered = new Set(
      [...container.querySelectorAll("[data-settings-anchor]")]
        .map((node) => node.getAttribute("data-settings-anchor")),
    );
    for (const entry of settingsEntriesForTab("activity")) {
      expect(
        rendered,
        `manifest promises #${entry.anchor} but nothing renders it`,
      ).toContain(entry.anchor);
    }
  });

  it("saves without a Save button", async () => {
    const { putPreferences } = installAdeMock();
    render(<ActivitySection />);
    await screen.findByText("Celebrations");

    expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Celebrations" }));
    await waitFor(() => expect(putPreferences).toHaveBeenCalledTimes(1));
    expect(putPreferences.mock.calls[0]![1]).toMatchObject({
      account: { celebrationsEnabled: false },
    });
  });

  it("writes the account-synced dock badge scope", async () => {
    const { putPreferences } = installAdeMock();
    render(<ActivitySection />);
    const control = await screen.findByRole("combobox", { name: "Dock badge counts" });

    expect((control as HTMLSelectElement).value).toBe("local");
    fireEvent.change(control, { target: { value: "account" } });

    await waitFor(() => expect(putPreferences).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        account: expect.objectContaining({ dockBadgeScope: "account" }),
      }),
    ));
  });

  it("syncs notch presentation and keeps this Mac's cache in step", async () => {
    const { putPreferences, updateSettings } = installAdeMock();
    render(<ActivitySection />);
    await screen.findByText("Notch behavior");

    const behavior = screen.getByRole("combobox", { name: "Notch behavior" });
    fireEvent.change(behavior, { target: { value: "always" } });

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings.mock.calls.at(-1)![0]).toMatchObject({ revealMode: "always" });
    // Synced so a second Mac inherits it…
    expect(putPreferences.mock.calls.at(-1)![1]).toMatchObject({
      account: { notchRevealMode: "always" },
    });
    // …and cached locally so an offline launch still opens it the same way.
    expect(window.localStorage.getItem("ade:attention:notch-reveal-mode")).toBe("always");
  });

  it("keeps notch presentation reachable but inert while the notch is off", async () => {
    installAdeMock();
    render(<ActivitySection />);
    await screen.findByText("ADE notch");

    fireEvent.click(screen.getByRole("switch", { name: "ADE notch" }));

    await waitFor(() => {
      expect(
        (screen.getByRole("combobox", { name: "Notch behavior" }) as HTMLSelectElement).disabled,
      ).toBe(true);
    });
    // Disabled, not unmounted: the manifest promises this anchor exists, and a
    // Cmd-K jump to a card that vanished is a dead end.
    expect(screen.getByRole("combobox", { name: "Notch behavior" })).toBeTruthy();
  });

  it("mutes one machine through the per-machine route", async () => {
    const { putMachinePreferences, putPreferences } = installAdeMock();
    activityStore.setState({
      itemsById: {
        a: machineItem("studio", "Studio Mac"),
        b: machineItem("laptop", "MacBook", false),
      },
    });
    render(<ActivitySection />);
    await screen.findByText("Studio Mac");

    fireEvent.click(screen.getByRole("switch", { name: "Notify me about Studio Mac" }));

    await waitFor(() => expect(putMachinePreferences).toHaveBeenCalledTimes(1));
    expect(putMachinePreferences.mock.calls[0]).toEqual([
      "user-1",
      "studio",
      { notificationsEnabled: false },
    ]);
    // Muting a machine must not rewrite the whole account document.
    expect(putPreferences).not.toHaveBeenCalled();
    expect(screen.getByText("Muted — visible in Activity, never notifies.")).toBeTruthy();
  });

  it("says so when no machine has reported yet", async () => {
    installAdeMock();
    render(<ActivitySection />);
    expect(await screen.findByText("No machines have reported Activity yet.")).toBeTruthy();
  });
});
