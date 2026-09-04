/* @vitest-environment jsdom */

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { OpenProjectBinding } from "../../../shared/types/core";
import type { InstalledPlugin, PluginPresenceRow } from "../../lib/pluginRuntimeBridge";

/**
 * The Marketplace with the project tab pointed at ANOTHER machine.
 *
 * `window.ade.plugins` follows the project tab's runtime, so this machine-level
 * page acts on whichever machine the tab is bound to: "installed" is what is
 * installed THERE, and an install installs THERE. Two things went wrong with
 * that, and both are asserted here rather than in `marketplaceModel.test.ts`,
 * because neither is a property of the fold — they are properties of the page's
 * loading gate.
 *
 * 1. A machine that could not answer for its registry left `pluginsLoaded`
 *    false forever (the registry retries on a backoff and never gives up), and
 *    the page's only loading gate read that as "still loading". The result was
 *    a Marketplace that drew its skeleton for as long as the machine stayed
 *    unreachable — which reads as a page that does not open at all.
 * 2. Nothing on the page said which machine it was talking about, so an empty
 *    list and an unasked machine looked identical.
 *
 * The real `useMarketplaceCatalogue` runs here on purpose. Mocking it — which
 * `MarketplacePage.test.tsx` does, for the row menu — would mock away the exact
 * gate this file exists to hold.
 */

const REMOTE_BINDING: OpenProjectBinding = {
  kind: "remote",
  key: "remote:studio",
  targetId: "target-1",
  runtimeName: "Mac Studio",
  projectId: "project-1",
  rootPath: "/Users/arul/repos/ade",
  displayName: "ade",
};

const store = {
  installedPlugins: [] as InstalledPlugin[],
  pluginsLoaded: false,
  pluginsLoadFailure: null as "unavailable" | "error" | null,
  projectBinding: REMOTE_BINDING as OpenProjectBinding | null,
  refreshes: 0,
};

vi.mock("../../state/appStore", () => ({
  useRootAppStore: (select: (state: unknown) => unknown) =>
    select({
      installedPlugins: store.installedPlugins,
      pluginsLoaded: store.pluginsLoaded,
      pluginsLoadFailure: store.pluginsLoadFailure,
      projectBinding: store.projectBinding,
      pluginThemeId: null,
      // The page remembers its view and filters across visits, and reads the
      // field on every render, so an absent `pluginViewState` throws before
      // anything draws. Left empty on purpose: this file asserts the loading
      // gate, not the remembered filters, and the page falls back to its own
      // default when nothing was stored.
      pluginViewState: {},
      setMarketplaceQuery: () => undefined,
      refreshInstalledPlugins: async () => {
        store.refreshes += 1;
        return store.pluginsLoaded;
      },
    }),
}));

/** Every bridge call the page makes, in order, with what it was given. */
const calls: string[] = [];
/** Presence as the REMOTE machine reports it: it is the "this machine" row. */
let presenceRows: PluginPresenceRow[] = [];

vi.mock("../../lib/pluginRuntimeBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/pluginRuntimeBridge")>()),
  pluginMarketplaceCapabilities: () => ({
    browse: true,
    install: true,
    uninstall: true,
    enable: true,
    machines: true,
    remoteInstall: false,
    config: true,
    contributions: true,
    usage: true,
    webhookIngress: true,
    inspect: false,
  }),
  // The directory as the remote machine answers for it.
  fetchMarketplaceIndex: async () => {
    calls.push("fetchMarketplaceIndex");
    return { entries: [], fetchedAt: "2026-09-02T00:00:00.000Z", origin: "network" as const };
  },
  readPluginPresence: async () => {
    calls.push("readPluginPresence");
    return presenceRows;
  },
  pluginRepoStarsSupported: () => false,
  fetchPluginRepoStars: async () => null,
  subscribeToPluginChanges: () => () => {},
  installPlugin: async (request: { pluginId?: string; machineKey?: string }) => {
    calls.push(`installPlugin:${request.pluginId}:${request.machineKey ?? "bound-runtime"}`);
    return { pluginId: request.pluginId ?? "", version: "1.0.0", displayName: "Tipsy" };
  },
  setPluginEnabled: async (pluginId: string, enabled: boolean) => {
    calls.push(`setPluginEnabled:${pluginId}:${enabled}`);
  },
  restartPlugin: async (pluginId: string) => {
    calls.push(`restartPlugin:${pluginId}`);
  },
  uninstallPlugin: async (pluginId: string) => {
    calls.push(`uninstallPlugin:${pluginId}`);
  },
}));

const { MarketplacePage } = await import("./MarketplacePage");
const { MARKETPLACE_LOCAL_INDEX } = await import("./marketplaceLocalIndex");

/**
 * A real bundled listing, so the gallery has a row without a directory fetch.
 * Deliberately not a featured one: a featured plugin draws twice, and this file
 * is asserting on which control was pressed.
 */
const BUNDLED = MARKETPLACE_LOCAL_INDEX.find((entry) => !entry.featured)
  ?? MARKETPLACE_LOCAL_INDEX[0];

/** The row's action button, by the tour id it already carries. */
const rowAction = (): HTMLElement => {
  const node = document.querySelector<HTMLElement>(
    `[data-tour="plugin:marketplace.action-${BUNDLED.pluginId}"]`,
  );
  if (!node) throw new Error("no action control on the row");
  return node;
};

/**
 * The row's overflow menu, scoped to this plugin's own row.
 *
 * Every listed row draws a "More actions" control, so the accessible name alone
 * matches once per row. The tour id names the one row this file asserts on.
 */
const rowMenu = (): HTMLElement | null => document.querySelector<HTMLElement>(
  `[data-tour="plugin:marketplace.row-menu-${BUNDLED.pluginId}"]`,
);

/** The install dialog's confirm button, by its own tour id. */
const installConfirm = (): HTMLElement => {
  const node = document.querySelector<HTMLElement>(
    '[data-tour="plugin:marketplace.install-confirm"]',
  );
  if (!node) throw new Error("the install dialog is not open");
  return node;
};

function installedPlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    pluginId: BUNDLED.pluginId,
    displayName: BUNDLED.displayName,
    version: BUNDLED.version,
    enabled: true,
    icon: null,
    accent: null,
    status: "running",
    tabs: [],
    theme: null,
    ...overrides,
  };
}

function presenceRow(overrides: Partial<PluginPresenceRow> = {}): PluginPresenceRow {
  return {
    machineKey: "machine-studio",
    machineName: "Mac Studio",
    pluginId: BUNDLED.pluginId,
    version: BUNDLED.version,
    enabled: true,
    online: true,
    isThisMachine: true,
    ...overrides,
  };
}

beforeEach(() => {
  // The install dialog draws the listing's star button, which asks the host
  // whether GitHub is connected. An absent namespace throws out of its effect.
  (window as unknown as { ade: unknown }).ade = {
    github: {
      getStatus: async () => ({ connected: false }),
      onStatusChanged: () => () => {},
    },
  };
  calls.length = 0;
  presenceRows = [presenceRow()];
  store.installedPlugins = [installedPlugin()];
  store.pluginsLoaded = true;
  store.pluginsLoadFailure = null;
  store.projectBinding = REMOTE_BINDING;
  store.refreshes = 0;
});

afterEach(() => cleanup());

const renderGallery = () => render(
  <MemoryRouter initialEntries={["/marketplace"]}>
    <MarketplacePage />
  </MemoryRouter>,
);

describe("the Marketplace on a project bound to another machine", () => {
  it("loads, and lists what that machine has installed", async () => {
    renderGallery();

    await waitFor(() => expect(screen.getAllByText(BUNDLED.displayName).length).toBeGreaterThan(0));
    // The rows came from the remote machine's own registry read, and the page
    // finished loading rather than sitting on its skeleton.
    expect(screen.queryByRole("status", { name: "Loading plugins" })).toBeNull();
    expect(calls).toContain("readPluginPresence");
    // Installed there, so the row reports it rather than offering an install.
    expect(rowAction().textContent).toBe("Installed");
    const menu = rowMenu();
    expect(menu).toBeTruthy();
    expect(menu?.getAttribute("aria-label")).toBe("More actions");
    // Nothing to say about a machine that answered.
    expect(screen.queryByText(/Can’t reach/)).toBeNull();
  });

  it("dispatches an install to that runtime, through the disclosure dialog", async () => {
    // Not installed on the remote machine, so its row offers an install.
    store.installedPlugins = [];
    presenceRows = [presenceRow({ version: null, enabled: false })];
    renderGallery();

    await waitFor(() => expect(screen.getAllByText(BUNDLED.displayName).length).toBeGreaterThan(0));
    expect(rowAction().textContent).toBe("Install");
    await act(async () => {
      fireEvent.click(rowAction());
    });

    // The press opens the dialog and installs NOTHING yet.
    await waitFor(() => expect(
      screen.getAllByText(`Install ${BUNDLED.displayName}`).length,
    ).toBeGreaterThan(0));
    expect(calls.filter((call) => call.startsWith("installPlugin:"))).toEqual([]);

    await act(async () => {
      fireEvent.click(installConfirm());
    });
    // No `machineKey`: the call rides the bound runtime, which IS the remote
    // machine. Passing one here would take the host's remote-install path.
    expect(calls).toContain(`installPlugin:${BUNDLED.pluginId}:bound-runtime`);
  });

  it("says the machine is unreachable instead of loading forever", async () => {
    store.installedPlugins = [];
    store.pluginsLoaded = false;
    store.pluginsLoadFailure = "error";
    renderGallery();

    // The page settles, names the machine, and still browses the catalogue.
    await waitFor(() => expect(screen.getByText(/Can’t reach Mac Studio/)).toBeTruthy());
    expect(screen.getAllByText(BUNDLED.displayName).length).toBeGreaterThan(0);
    // Nothing is offered against a registry nobody read: an empty installed
    // list from an unasked machine must not become an Install button.
    expect(screen.queryByRole("button", { name: "Install plugin" })).toBeNull();
    expect(calls.filter((call) => call.startsWith("installPlugin:"))).toEqual([]);
  });

  it("says a machine that runs no plugin host cannot answer, and does not throw", async () => {
    store.installedPlugins = [];
    store.pluginsLoaded = false;
    store.pluginsLoadFailure = "unavailable";
    renderGallery();

    await waitFor(() => expect(screen.getByText(/Mac Studio doesn’t run plugins/)).toBeTruthy());
    expect(screen.getAllByText(BUNDLED.displayName).length).toBeGreaterThan(0);
  });

  it("names this computer when the project tab is local", async () => {
    store.projectBinding = null;
    store.installedPlugins = [];
    store.pluginsLoaded = false;
    store.pluginsLoadFailure = "error";
    renderGallery();

    await waitFor(() => expect(screen.getByText(/isn’t answering about plugins/)).toBeTruthy());
    expect(screen.queryByText(/Mac Studio/)).toBeNull();
  });
});
