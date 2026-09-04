/* @vitest-environment jsdom */

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { InstalledPlugin, PluginPresenceRow } from "../../lib/pluginRuntimeBridge";
import type { MarketplaceListing } from "./marketplaceModel";

/**
 * Every install control on the plugin detail page.
 *
 * The install dialog is the whole of ADE's plugin permission model: it is the
 * one place a reader is told what the plugin adds before its code runs. The
 * page had three controls that install, and only the header's went through it —
 * the machine matrix and the update card each called the install bridge on the
 * press. So which button you happened to use decided whether you were told
 * anything at all, and the middle of the page was the one that told you least.
 *
 * This file walks every control that can install and holds one rule: NOTHING
 * reaches the install bridge until the dialog's own confirm is pressed.
 */

const calls: string[] = [];
let activeThemeId: string | null = null;

const registry = {
  plugins: [] as InstalledPlugin[],
  loaded: true,
  failure: null as "unavailable" | "error" | null,
};

vi.mock("../../state/appStore", () => ({
  useRootAppStore: (select: (state: unknown) => unknown) =>
    select({
      installedPlugins: registry.plugins,
      pluginsLoaded: registry.loaded,
      pluginsLoadFailure: registry.failure,
      projectBinding: null,
      pluginThemeId: activeThemeId,
      setPluginThemeId: (pluginId: string | null) => {
        activeThemeId = pluginId;
        calls.push(`setPluginThemeId:${pluginId ?? "none"}`);
      },
      refreshInstalledPlugins: async () => registry.loaded,
    }),
}));

vi.mock("../../lib/pluginRuntimeBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/pluginRuntimeBridge")>()),
  // The dialog probes the host for itself, so this has to answer here too — an
  // unprobed host disables the confirm button and the walk proves nothing.
  pluginMarketplaceCapabilities: () => ({
    browse: true,
    install: true,
    uninstall: true,
    enable: true,
    machines: true,
    remoteInstall: true,
    config: true,
    contributions: true,
    usage: false,
    webhookIngress: false,
    inspect: false,
  }),
  installPlugin: async (request: { pluginId?: string; machineKey?: string; version?: string }) => {
    calls.push(
      `installPlugin:${request.pluginId}:${request.version ?? "-"}:${request.machineKey ?? "here"}`,
    );
    return { pluginId: request.pluginId ?? "", version: request.version ?? "", displayName: "Tipsy" };
  },
  setPluginEnabled: async (pluginId: string, enabled: boolean) => {
    calls.push(`setPluginEnabled:${pluginId}:${enabled}`);
  },
  restartPlugin: async () => {},
  uninstallPlugin: async () => {},
  openPluginLogs: async () => {},
  readPluginManifest: async () => null,
  readPluginReadme: async () => null,
  readPluginUsage: async () => [],
  readPluginWebhookIngress: async () => [],
}));

const LISTING: MarketplaceListing = {
  pluginId: "tipsy",
  displayName: "Tipsy",
  author: "ADE",
  description: "A drink counter.",
  version: "2.0.0",
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
  addsSummary: ["A button in the composer"],
  surfaces: [],
  themeTokens: null,
  origin: "directory",
};

type RegistryState = { kind: "ready" | "loading" | "unavailable" | "unreachable" };

/** Mutable, so a test can put the page on a machine that never answered. */
let catalogueRegistry: RegistryState = { kind: "ready" };

const catalogue = {
  listings: [LISTING],
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
    // The machine matrix draws its own machine's row whatever this says; a
    // remote install arm is a separate host capability.
    remoteInstall: true,
    config: true,
    contributions: true,
    usage: false,
    webhookIngress: false,
    inspect: false,
  },
};

let presenceRows: PluginPresenceRow[] = [];

vi.mock("./useMarketplace", () => ({
  useMarketplaceCatalogue: () => ({ ...catalogue, registry: catalogueRegistry }),
  useMarketplaceMachineName: () => null,
  usePluginPresence: () => ({ rows: presenceRows, loading: false }),
  usePluginRepoStars: () => new Map<string, number>(),
}));

const { MarketplaceDetailPage } = await import("./MarketplaceDetailPage");

function presenceRow(overrides: Partial<PluginPresenceRow> = {}): PluginPresenceRow {
  return {
    machineKey: "machine-a",
    machineName: "This Mac",
    pluginId: "tipsy",
    version: null,
    enabled: false,
    online: true,
    isThisMachine: true,
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

const renderDetail = () => render(
  <MemoryRouter initialEntries={["/marketplace/tipsy"]}>
    <MarketplaceDetailPage pluginId="tipsy" />
  </MemoryRouter>,
);

/** Every control on the page that can lead to an install. */
const installControls = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(
    '[data-tour="plugin:marketplace.detail-install"],'
    + '[data-tour="plugin:marketplace.update-action"],'
    + '[data-tour="plugin:marketplace.machine-install"]',
  ),
];

const dialogConfirm = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-tour="plugin:marketplace.install-confirm"]');

beforeEach(() => {
  // The star button asks the host whether GitHub is connected. It is a
  // decoration on this page, and an absent namespace throws out of an effect —
  // so the stub is here rather than the button being mocked away.
  (window as unknown as { ade: unknown }).ade = {
    github: {
      getStatus: async () => ({ connected: false }),
      onStatusChanged: () => () => {},
    },
  };
  calls.length = 0;
  activeThemeId = null;
  catalogue.listings = [LISTING];
  registry.plugins = [];
  registry.loaded = true;
  registry.failure = null;
  catalogueRegistry = { kind: "ready" };
  presenceRows = [presenceRow()];
});

afterEach(() => cleanup());

describe("every install control on the plugin detail page", () => {
  it("opens the disclosure dialog and installs nothing until it is confirmed", async () => {
    // Installed at an older version, so the update card draws as well: this is
    // the state that puts all three controls on one page.
    registry.plugins = [installedPlugin({ version: "1.0.0" })];
    presenceRows = [
      presenceRow({ version: "1.0.0", enabled: true }),
      // Another machine with no row for THIS plugin: the matrix reads that as
      // missing there, which is the state that draws its Install.
      presenceRow({
        machineKey: "machine-b",
        machineName: "Mac Studio",
        isThisMachine: false,
        pluginId: "other",
      }),
    ];
    renderDetail();

    await waitFor(() => expect(installControls().length).toBeGreaterThan(0));
    const controls = installControls();
    // The header offers a toggle once the plugin is installed here, so the two
    // that remain are exactly the two that used to skip the dialog.
    expect(controls.length).toBeGreaterThanOrEqual(2);

    for (const control of controls) {
      calls.length = 0;
      await act(async () => {
        fireEvent.click(control);
      });
      // The press disclosed, and installed nothing.
      const confirm = dialogConfirm();
      expect(confirm, `${control.dataset.tour} installed without the dialog`).toBeTruthy();
      expect(calls.filter((call) => call.startsWith("installPlugin:"))).toEqual([]);
      // Cancelling is a real answer: still nothing installed.
      await act(async () => {
        fireEvent.click(screen.getByText("Cancel"));
      });
      expect(calls.filter((call) => call.startsWith("installPlugin:"))).toEqual([]);
    }
  });

  it("installs the version the update card offered, once confirmed", async () => {
    registry.plugins = [installedPlugin({ version: "1.0.0" })];
    renderDetail();

    await waitFor(() => expect(
      document.querySelector('[data-tour="plugin:marketplace.update-action"]'),
    ).toBeTruthy());
    await act(async () => {
      fireEvent.click(document.querySelector<HTMLElement>('[data-tour="plugin:marketplace.update-action"]')!);
    });
    // The dialog says what it is doing, rather than borrowing the install word.
    expect(screen.getAllByText("Update Tipsy").length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(dialogConfirm()!);
    });
    expect(calls).toEqual(["installPlugin:tipsy:2.0.0:here"]);
  });

  it("carries the machine the matrix row named into the install", async () => {
    presenceRows = [
      presenceRow(),
      presenceRow({
        machineKey: "machine-b",
        machineName: "Mac Studio",
        isThisMachine: false,
        pluginId: "other",
      }),
    ];
    renderDetail();

    await waitFor(() => expect(
      document.querySelectorAll('[data-tour="plugin:marketplace.machine-install"]').length,
    ).toBe(2));
    const rows = [...document.querySelectorAll<HTMLElement>('[data-tour="plugin:marketplace.machine-install"]')];

    // The other machine's row names it, in the title and in the call.
    await act(async () => {
      fireEvent.click(rows[1]);
    });
    expect(screen.getAllByText("Install Tipsy on Mac Studio").length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(dialogConfirm()!);
    });
    expect(calls).toEqual(["installPlugin:tipsy:2.0.0:machine-b"]);
  });

  it("sends no machineKey for this machine, which the host reads as elsewhere", async () => {
    renderDetail();

    await waitFor(() => expect(
      document.querySelector('[data-tour="plugin:marketplace.machine-install"]'),
    ).toBeTruthy());
    await act(async () => {
      fireEvent.click(document.querySelector<HTMLElement>('[data-tour="plugin:marketplace.machine-install"]')!);
    });
    await act(async () => {
      fireEvent.click(dialogConfirm()!);
    });
    expect(calls).toEqual(["installPlugin:tipsy:2.0.0:here"]);
  });

  it("offers no install at all when the machine never answered for its registry", async () => {
    registry.loaded = false;
    registry.failure = "error";
    catalogueRegistry = { kind: "unreachable" };
    renderDetail();

    await waitFor(() => expect(screen.getByText(/isn’t answering about plugins/)).toBeTruthy());
    expect(installControls()).toEqual([]);
  });
});

describe("an installed theme detail page", () => {
  beforeEach(() => {
    catalogue.listings = [{ ...LISTING, isTheme: true }];
    registry.plugins = [installedPlugin({
      status: "none",
      theme: { displayName: "Tipsy", tokens: { dark: {}, light: {} } },
    })];
  });

  it("offers Use theme instead of the generic enable toggle", async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText("Use theme")).toBeTruthy());
    expect(document.querySelector('[data-tour="plugin:marketplace.detail-theme-action"]')).toBeTruthy();
    expect(document.querySelector('[data-tour="plugin:marketplace.detail-toggle"]')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText("Use theme"));
    });
    expect(calls).toEqual(["setPluginThemeId:tipsy"]);
  });

  it("shows the active state and stops using the theme without disabling it", async () => {
    activeThemeId = "tipsy";
    renderDetail();
    await waitFor(() => expect(screen.getByText("Active theme")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText("Stop using"));
    });
    expect(calls).toEqual(["setPluginThemeId:none"]);
  });
});
