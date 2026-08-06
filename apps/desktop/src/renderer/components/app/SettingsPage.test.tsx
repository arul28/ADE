/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { SettingsPage } from "./SettingsPage";

/**
 * The settings shell resolves tabs, legacy deep links, and search through
 * `settingsManifest`. `settingsManifest.test.ts` covers the resolution rules
 * themselves; these tests cover the wiring — that the shell actually consults
 * the manifest, and that search filtering operates on the real rendered DOM.
 *
 * Sections are stubbed so a shell test doesn't stand up Providers/Storage IPC.
 * The stubs still emit `data-settings-anchor`, which is what the filter reads.
 */

function stubSection(anchors: string[]) {
  return () => (
    <>
      {anchors.map((anchor) => (
        <section key={anchor} data-settings-anchor={anchor}>
          {anchor}
        </section>
      ))}
    </>
  );
}

vi.mock("../settings/ProjectSection", () => ({ ProjectSection: stubSection(["project"]) }));
vi.mock("../settings/ProductAnalyticsSection", () => ({ ProductAnalyticsSection: stubSection(["product-analytics"]) }));
vi.mock("../settings/AboutSection", () => ({
  AboutSection: () => (
    <section data-settings-anchor="about">
      <section data-settings-anchor="auto-updates">auto-updates</section>
    </section>
  ),
}));
vi.mock("../settings/AppearanceSection", () => ({ AppearanceSection: stubSection(["theme", "chat-font-size"]) }));
vi.mock("../settings/ProvidersSection", () => ({ ProvidersSection: stubSection(["ai-providers"]) }));
vi.mock("../settings/AiFeaturesSection", () => ({ AiFeaturesSection: stubSection(["background-jobs"]) }));
vi.mock("../settings/DictationSection", () => ({ DictationSection: stubSection(["voice-input"]) }));
vi.mock("../settings/LaneBehaviorSection", () => ({ LaneBehaviorSection: stubSection(["auto-rebase", "rebase-suggestions"]) }));
vi.mock("../settings/LaneTemplatesSection", () => ({ LaneTemplatesSection: stubSection(["lane-templates"]) }));
vi.mock("../settings/PrChatTranscriptsSection", () => ({ PrChatTranscriptsSection: stubSection(["pr-chat-transcripts"]) }));
vi.mock("../settings/GitHubIntegrationSection", () => ({ GitHubIntegrationSection: stubSection(["github-connection"]) }));
vi.mock("../settings/LinearIntegrationSection", () => ({ LinearIntegrationSection: stubSection(["linear-connection"]) }));
vi.mock("../settings/AdeCliSection", () => ({ AdeCliSection: stubSection([]) }));
vi.mock("../settings/NotificationsSection", () => ({ NotificationsSection: stubSection(["notification-events"]) }));
vi.mock("../settings/SecretsSection", () => ({ SecretsSection: stubSection(["secrets"]) }));
vi.mock("../settings/StorageSection", () => ({ StorageSection: stubSection(["storage"]) }));
vi.mock("../settings/SessionLifecycleSection", () => ({ SessionLifecycleSection: stubSection(["session-lifecycle"]) }));
vi.mock("../settings/AdeUsageSection", () => ({ AdeUsageSection: stubSection(["ade-usage"]) }));
vi.mock("../settings/RemoteContextBadge", () => ({ RemoteSettingsBanner: () => null }));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.search}${location.hash}`}</div>;
}

function renderSettings(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const searchBox = () => screen.getByPlaceholderText("Search all settings");
const visibleAnchors = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-settings-anchor]")]
    .filter((node) => node.style.display !== "none")
    .map((node) => node.dataset.settingsAnchor);

afterEach(() => cleanup());

describe("SettingsPage", () => {
  it("opens the tab named in the URL", async () => {
    renderSettings("/settings?tab=notifications");
    expect(await screen.findByRole("heading", { name: "Notifications" })).toBeTruthy();
  });

  it("resolves a legacy tab id and rewrites the URL to the canonical one", async () => {
    // `?tab=lane-templates` predates the nine-tab split. It must still land —
    // a legacy deep link that silently opens the wrong page is invisible in
    // review and very visible to whoever saved the URL.
    renderSettings("/settings?tab=lane-templates");

    expect(await screen.findByRole("heading", { name: "Lanes" })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("?tab=lanes-git");
    });
  });

  it("routes the legacy integrations tab to Integrations, not General", async () => {
    renderSettings("/settings?tab=integrations");
    expect(await screen.findByRole("heading", { name: "Integrations" })).toBeTruthy();
  });

  it("follows the hash's owning tab when ?tab= disagrees with it", async () => {
    // Links written before GitHub moved out of General still say
    // `?tab=general#github-connection`. The hash names one exact card, so it
    // wins: landing on General (where the card no longer is) is what made the
    // "Set up ADE GitHub App" banner look like it did nothing.
    renderSettings("/settings?tab=general#github-connection");

    expect(await screen.findByRole("heading", { name: "Integrations" })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("?tab=integrations#github-connection");
    });
  });

  it("falls back to General for a tab id it has never shipped", async () => {
    renderSettings("/settings?tab=not-a-real-tab");
    expect(await screen.findByRole("heading", { name: "General" })).toBeTruthy();
  });

  it("hides cards that do not match the search, and restores them when cleared", async () => {
    const { container } = renderSettings("/settings?tab=lanes-git");
    await screen.findByRole("heading", { name: "Lanes" });

    expect(visibleAnchors(container)).toContain("lane-templates");

    fireEvent.change(searchBox(), { target: { value: "rebase" } });
    await waitFor(() => {
      expect(visibleAnchors(container)).toContain("auto-rebase");
    });
    expect(visibleAnchors(container)).not.toContain("lane-templates");

    fireEvent.change(searchBox(), { target: { value: "" } });
    await waitFor(() => {
      expect(visibleAnchors(container)).toContain("lane-templates");
    });
  });

  it("keeps a parent card visible when a nested setting matches", async () => {
    const { container } = renderSettings("/settings?tab=general");
    await screen.findByRole("heading", { name: "General" });

    fireEvent.change(searchBox(), { target: { value: "updates" } });

    await waitFor(() => {
      expect(visibleAnchors(container)).toContain("auto-updates");
      expect(visibleAnchors(container)).toContain("about");
    });
  });

  it("offers matches from other tabs and navigates to the one you pick", async () => {
    renderSettings("/settings?tab=lanes-git");
    await screen.findByRole("heading", { name: "Lanes" });

    fireEvent.change(searchBox(), { target: { value: "theme" } });

    const crossTab = await screen.findByRole("button", { name: /Theme/ });
    fireEvent.click(crossTab);

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("?tab=appearance#theme");
    });
  });

  it("says so when nothing on the current tab matches", async () => {
    renderSettings("/settings?tab=secrets");
    await screen.findByRole("heading", { name: "Secrets" });

    fireEvent.change(searchBox(), { target: { value: "zzzznotasetting" } });

    expect(await screen.findByText(/Nothing in Secrets matches/)).toBeTruthy();
  });
});
