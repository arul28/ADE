/* @vitest-environment jsdom */

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { InstalledPlugin } from "../../lib/pluginRuntimeBridge";
import type { MarketplaceListing } from "./marketplaceModel";

/**
 * The Marketplace row's quick-action menu.
 *
 * The alpha test's explicit ask: every single-plugin operation lived one
 * navigation away, so turning a plugin off meant leaving the list, acting, and
 * coming back to a list that had scrolled. What is asserted here is not the
 * menu's shape — `marketplaceModel.test.ts` says why rendering is generally not
 * tested — but the two things a shortcut can get WRONG: which operation each
 * row runs, and whether the shortcut is also a way around the uninstall gate.
 */

const calls: string[] = [];
/** What `uninstallPlugin` does. The gate's refusal is the interesting case. */
let uninstallOutcome: () => Promise<void> = async () => {};

const registry = { plugins: [] as InstalledPlugin[], refreshes: 0 };

vi.mock("../../state/appStore", () => ({
  useRootAppStore: (select: (state: unknown) => unknown) =>
    select({
      installedPlugins: registry.plugins,
      pluginsLoaded: true,
      pluginThemeId: null,
      refreshInstalledPlugins: async () => {
        registry.refreshes += 1;
        return true;
      },
    }),
}));

vi.mock("../../lib/pluginRuntimeBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/pluginRuntimeBridge")>()),
  setPluginEnabled: async (pluginId: string, enabled: boolean) => {
    calls.push(`setPluginEnabled:${pluginId}:${enabled}`);
  },
  restartPlugin: async (pluginId: string) => {
    calls.push(`restartPlugin:${pluginId}`);
  },
  uninstallPlugin: async (pluginId: string) => {
    calls.push(`uninstallPlugin:${pluginId}`);
    await uninstallOutcome();
  },
}));

function listing(overrides: Partial<MarketplaceListing> = {}): MarketplaceListing {
  return {
    pluginId: "tipsy",
    displayName: "Tipsy",
    author: "ADE",
    description: "A drink counter.",
    version: "1.0.0",
    icon: null,
    accent: null,
    iconUrl: null,
    repo: null,
    media: [],
    links: null,
    official: false,
    featured: false,
    isTheme: false,
    installs: null,
    stars: null,
    publishedAt: null,
    source: "https://example.test/tipsy",
    changelogUrl: null,
    readme: null,
    manifest: null,
    addsSummary: [],
    surfaces: [],
    themeTokens: null,
    origin: "directory",
    ...overrides,
  };
}

function installedPlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    pluginId: "tipsy",
    displayName: "Tipsy",
    version: "1.0.0",
    enabled: true,
    icon: null,
    accent: null,
    status: "running",
    tabs: [],
    theme: null,
    ...overrides,
  };
}

const CATALOGUE = {
  listings: [listing()],
  state: { kind: "live" as const, fetchedAt: null, origin: "cache" as const },
  loading: false,
  refreshing: false,
  refresh: () => {},
  capabilities: {
    browse: true,
    install: true,
    uninstall: true,
    enable: true,
    machines: true,
    remoteInstall: false,
    stars: false,
  },
};

vi.mock("./useMarketplace", () => ({
  useMarketplaceCatalogue: () => CATALOGUE,
  usePluginPresence: () => ({ rows: [], loading: false }),
  usePluginRepoStars: () => new Map<string, number>(),
}));

const { MarketplacePage } = await import("./MarketplacePage");

beforeEach(() => {
  calls.length = 0;
  registry.plugins = [installedPlugin()];
  uninstallOutcome = async () => {};
});

afterEach(() => cleanup());

const renderGallery = () => render(
  <MemoryRouter initialEntries={["/marketplace"]}>
    <MarketplacePage />
  </MemoryRouter>,
);

const openRowMenu = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  });
};

describe("the quick-action menu on a plugin row", () => {
  it("offers the three single-plugin operations without opening the detail page", async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());
    await openRowMenu();

    expect(screen.getByText("Turn off")).toBeTruthy();
    expect(screen.getByText("Restart")).toBeTruthy();
    expect(screen.getByText("Remove…")).toBeTruthy();
  });

  it("runs the enable toggle against this plugin, and flips with its state", async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());
    await openRowMenu();
    await act(async () => {
      fireEvent.click(screen.getByText("Turn off"));
    });
    expect(calls).toEqual(["setPluginEnabled:tipsy:false"]);

    // A plugin already off offers the other direction, and asks for it.
    cleanup();
    calls.length = 0;
    registry.plugins = [installedPlugin({ enabled: false })];
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());
    await openRowMenu();
    await act(async () => {
      fireEvent.click(screen.getByText("Turn on"));
    });
    expect(calls).toEqual(["setPluginEnabled:tipsy:true"]);
  });

  it("restarts through the host's own reload, and offers it only to a plugin that runs", async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());
    await openRowMenu();
    await act(async () => {
      fireEvent.click(screen.getByText("Restart"));
    });
    expect(calls).toEqual(["restartPlugin:tipsy"]);

    // A theme has no child process, so there is nothing to restart and the row
    // does not pretend otherwise.
    cleanup();
    registry.plugins = [installedPlugin({ status: "none" })];
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());
    await openRowMenu();
    expect(screen.queryByText("Restart")).toBeNull();
    expect(screen.getByText("Remove…")).toBeTruthy();
  });

  /**
   * The one thing a shortcut must not become. `plugin.uninstall` is CTO-only
   * and approval-gated, and this menu reaches it through the same call the
   * detail page makes — so a context the gate refuses is refused here too, and
   * the refusal is shown rather than swallowed into a button that did nothing.
   */
  it("removes through the gated call, and reports the gate's refusal", async () => {
    uninstallOutcome = async () => {
      throw new Error("plugin_role_denied: this needs the operator");
    };
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());
    await openRowMenu();

    // Never straight to the removal: the same confirmation the detail page asks.
    await act(async () => {
      fireEvent.click(screen.getByText("Remove…"));
    });
    expect(calls).toEqual([]);
    expect(screen.getByText("Remove Tipsy?")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Remove"));
    });
    expect(calls).toEqual(["uninstallPlugin:tipsy"]);
    await waitFor(() => expect(screen.getByText(/operator/)).toBeTruthy());
  });

  /** A plugin this machine does not have has nothing to turn off or remove. */
  it("is absent on a row for a plugin that is not installed here", async () => {
    registry.plugins = [];
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });
});
