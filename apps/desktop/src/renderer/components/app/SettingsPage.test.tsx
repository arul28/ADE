/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isInaccessible } from "@testing-library/dom";
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
vi.mock("../settings/DiagnosticsSharingSection", () => ({ DiagnosticsSharingSection: stubSection(["diagnostics-sharing"]) }));
// General's ADE card holds the update rows, so it nests them like the real page.
vi.mock("../settings/general/GeneralPage", () => ({
  GeneralPage: () => (
    <>
      <section data-settings-anchor="needs-attention">needs-attention</section>
      <section data-settings-anchor="at-a-glance">at-a-glance</section>
      <section data-settings-anchor="about">
        <section data-settings-anchor="auto-updates">auto-updates</section>
      </section>
    </>
  ),
}));
vi.mock("../settings/AppearanceSection", () => ({ AppearanceSection: stubSection(["theme", "chat-font-size"]) }));
vi.mock("../settings/ProvidersSection", () => ({ ProvidersSection: stubSection(["ai-providers"]) }));
vi.mock("../settings/AiFeaturesSection", () => ({ AiFeaturesSection: stubSection(["background-jobs"]) }));
vi.mock("../settings/DictationSection", () => ({ DictationSection: stubSection(["voice-input"]) }));
vi.mock("../settings/LaneTemplatesSection", () => ({ LaneTemplatesSection: stubSection(["lane-templates"]) }));
vi.mock("../settings/PrChatTranscriptsSection", () => ({ PrChatTranscriptsSection: stubSection(["pr-chat-transcripts"]) }));
vi.mock("../settings/KeepAwakeSection", () => ({ KeepAwakeSection: stubSection(["keep-awake"]) }));
vi.mock("../settings/CaptureGestureSection", () => ({ CaptureGestureSection: stubSection(["capture-gesture"]) }));
vi.mock("../settings/BrowserLinksSection", () => ({ BrowserLinksSection: stubSection(["link-open-mode"]) }));
vi.mock("../settings/BrowserAgentAccessSection", () => ({ BrowserAgentAccessSection: stubSection(["browser-agent-access"]) }));
vi.mock("../settings/GitHubIntegrationSection", () => ({ GitHubIntegrationSection: stubSection(["github-connection"]) }));
vi.mock("../settings/LinearIntegrationSection", () => ({ LinearIntegrationSection: stubSection(["linear-connection"]) }));
vi.mock("../settings/AdeCliSection", () => ({ AdeCliSection: stubSection([]) }));
vi.mock("../settings/NotificationsSection", () => ({ NotificationsSection: stubSection(["notification-events"]) }));
vi.mock("../settings/SecretsSection", () => ({ SecretsSection: stubSection(["secrets"]) }));
vi.mock("../settings/lanes/LanesSettingsPage", () => ({
  LanesSettingsPage: stubSection(["lane-list", "new-lane-start", "lane-templates"]),
  StorageSettingsPage: stubSection(["storage", "archive"]),
}));
vi.mock("../settings/location/LocationPage", () => ({ LocationPage: stubSection(["project-location", "project-health"]) }));
vi.mock("../settings/health/HealthService", () => ({ ServiceStatusSection: stubSection(["diagnostics"]) }));
vi.mock("../settings/BackgroundServiceSection", () => ({ BackgroundServiceSection: stubSection(["background-service"]) }));
vi.mock("../settings/ResetAdeSection", () => ({ ResetAdeSection: stubSection(["reset-ade"]) }));
vi.mock("../settings/SessionLifecycleSection", () => ({ SessionLifecycleSection: stubSection(["session-lifecycle"]) }));
vi.mock("../settings/AdeUsageSection", () => ({ AdeUsageSection: stubSection(["ade-usage"]) }));
vi.mock("../settings/RemoteContextBadge", () => ({ RemoteSettingsBanner: () => null }));
vi.mock("../account/AccountPage", () => ({
  AccountPage: ({ embedded }: { embedded?: boolean }) => <div>{embedded ? "account embedded" : "account page"}</div>,
}));

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
    .filter((node) => !isInaccessible(node))
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

    expect(await screen.findByRole("heading", { name: "Lanes", level: 1 })).toBeTruthy();
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
    expect(await screen.findByRole("heading", { name: "General", level: 1 })).toBeTruthy();
  });

  it("lands a legacy page's link on the card it named, on the page that holds it now", async () => {
    // `?tab=archive` was the Archive page; the archive is a view of
    // Project → Storage & cleanup now, so the link opens that page at the archive.
    renderSettings("/settings?tab=archive");
    expect(await screen.findByRole("heading", { name: "Storage & cleanup", level: 1 })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("?tab=storage#archive");
    });
  });

  it("hides cards that do not match the search, and restores them when cleared", async () => {
    const { container } = renderSettings("/settings?tab=lanes-git");
    await screen.findByRole("heading", { name: "Lanes", level: 1 });

    expect(visibleAnchors(container)).toContain("lane-templates");

    fireEvent.change(searchBox(), { target: { value: "fetch" } });
    await waitFor(() => {
      expect(visibleAnchors(container)).toContain("new-lane-start");
    });
    expect(visibleAnchors(container)).not.toContain("lane-templates");

    fireEvent.change(searchBox(), { target: { value: "" } });
    await waitFor(() => {
      expect(visibleAnchors(container)).toContain("lane-templates");
    });
  });

  it("keeps a parent card visible when a nested setting matches", async () => {
    const { container } = renderSettings("/settings?tab=general");
    await screen.findByRole("heading", { name: "General", level: 1 });

    fireEvent.change(searchBox(), { target: { value: "updates" } });

    await waitFor(() => {
      expect(visibleAnchors(container)).toContain("auto-updates");
      expect(visibleAnchors(container)).toContain("about");
    });
  });

  it("offers matches from other tabs and navigates to the one you pick", async () => {
    renderSettings("/settings?tab=lanes-git");
    await screen.findByRole("heading", { name: "Lanes", level: 1 });

    fireEvent.change(searchBox(), { target: { value: "theme" } });

    const crossTab = await screen.findByRole("button", { name: /Theme/ });
    fireEvent.click(crossTab);

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("?tab=appearance#theme");
    });
  });

  it("lists General, then the You group starting with Account, and renders the account page in place", async () => {
    renderSettings("/settings?tab=account");

    expect(await screen.findByRole("heading", { name: "Account" })).toBeTruthy();
    expect(screen.getByText("account embedded")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const rows = [...nav.querySelectorAll("button")].map((button) => button.textContent);
    // General sits alone at the top, then the groups: You (Account, Usage),
    // then App, which opens on Chat.
    expect(rows.slice(0, 4)).toEqual(["General", "Account", "Usage", "Chat"]);
  });

  it("carries help, zoom, and the identity row above the sections", async () => {
    renderSettings("/settings?tab=appearance");
    await screen.findByRole("heading", { name: "Appearance" });

    expect(screen.getByRole("button", { name: "Help menu" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeTruthy();

    // Signed out, the identity row names the session state and still opens Account.
    fireEvent.click(screen.getByRole("button", { name: /^Account, / }));
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("?tab=account");
    });
    expect(await screen.findByText("account embedded")).toBeTruthy();
  });

  it("says so when nothing on the current tab matches", async () => {
    renderSettings("/settings?tab=secrets");
    await screen.findByRole("heading", { name: "Secrets" });

    fireEvent.change(searchBox(), { target: { value: "zzzznotasetting" } });

    expect(await screen.findByText(/No setting matches/)).toBeTruthy();
  });
});
