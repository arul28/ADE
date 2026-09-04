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
let activeThemeId: string | null = null;
/** What the store hands the page back as its remembered view and filters. */
let storedQuery: unknown = undefined;
/** Every query the page asked the store to remember, in order. */
const storedWrites: unknown[] = [];
/** What `uninstallPlugin` does. The gate's refusal is the interesting case. */
let uninstallOutcome: () => Promise<void> = async () => {};

const registry = { plugins: [] as InstalledPlugin[], refreshes: 0 };

vi.mock("../../state/appStore", () => ({
  useRootAppStore: (select: (state: unknown) => unknown) =>
    select({
      installedPlugins: registry.plugins,
      pluginsLoaded: true,
      pluginsLoadFailure: null,
      projectBinding: null,
      pluginThemeId: activeThemeId,
      theme: "dark",
      pluginViewState: { marketplaceQuery: storedQuery },
      setMarketplaceQuery: (query: unknown) => {
        storedWrites.push(query);
      },
      setPluginThemeId: (pluginId: string | null) => {
        activeThemeId = pluginId;
        calls.push(`setPluginThemeId:${pluginId ?? "none"}`);
      },
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
    kind: "view",
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
  registry: { kind: "ready" as const },
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
  useMarketplaceMachineName: () => null,
  usePluginPresence: () => ({ rows: [], loading: false }),
  usePluginRepoStars: () => new Map<string, number>(),
}));

const { MarketplacePage } = await import("./MarketplacePage");

beforeEach(() => {
  calls.length = 0;
  storedWrites.length = 0;
  storedQuery = undefined;
  activeThemeId = null;
  CATALOGUE.listings = [listing()];
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

  /** A plugin this machine does not have still gets a kebab, with Install. */
  it("offers Install on a row for a plugin that is not installed here", async () => {
    registry.plugins = [];
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());
    await openRowMenu();
    expect(document.querySelector('[data-tour="plugin:marketplace.row-install-tipsy"]')).toBeTruthy();
    expect(screen.queryByText("Remove…")).toBeNull();
  });

  it("uses theme language and activates an installed theme", async () => {
    CATALOGUE.listings = [listing({ isTheme: true })];
    registry.plugins = [installedPlugin({
      status: "none",
      theme: { displayName: "Tipsy", tokens: { dark: {}, light: {} } },
    })];
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());
    await openRowMenu();

    expect(screen.getByText("Use theme")).toBeTruthy();
    expect(screen.queryByText("Turn off")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText("Use theme"));
    });
    expect(calls).toEqual(["setPluginThemeId:tipsy"]);
  });

  it("stops using the active theme without disabling or uninstalling it", async () => {
    activeThemeId = "tipsy";
    CATALOGUE.listings = [listing({ isTheme: true })];
    registry.plugins = [installedPlugin({
      status: "none",
      theme: { displayName: "Tipsy", tokens: { dark: {}, light: {} } },
    })];
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());
    await openRowMenu();

    await act(async () => {
      fireEvent.click(screen.getByText("Stop using"));
    });
    expect(calls).toEqual(["setPluginThemeId:none"]);
  });
});

/**
 * `?install=<source>` — the in-chat approval card's "View in Marketplace".
 *
 * A folder on this machine has no catalogue page, so the link hands the source
 * over instead and the install dialog renders the disclosure for it.
 */
describe("a candidate handed over in the URL", () => {
  const HANDED = "/Users/arul/repos/ade/plugins/focus";

  const renderWithHandoff = () => render(
    <MemoryRouter initialEntries={[`/marketplace?install=${encodeURIComponent(HANDED)}`]}>
      <MarketplacePage />
    </MemoryRouter>,
  );

  it("opens the install dialog on that exact source", async () => {
    renderWithHandoff();
    await waitFor(() => {
      expect(document.querySelector<HTMLInputElement>("#plugin-install-source")?.value).toBe(HANDED);
    });
  });

  it("consumes the parameter, so the dialog does not come back on its own", async () => {
    renderWithHandoff();
    await waitFor(() => {
      expect(document.querySelector<HTMLInputElement>("#plugin-install-source")?.value).toBe(HANDED);
    });
    // Closed by the reader, and nothing reopens it: the URL no longer carries
    // the handoff.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    await waitFor(() => {
      expect(document.querySelector("#plugin-install-source")).toBeNull();
    });
  });
});

/**
 * The gallery's two views and its filter bar.
 *
 * What is asserted here is not the bar's shape — `marketplaceModel.test.ts`
 * says why rendering is generally not tested — but the four things a filter bar
 * can get WRONG: showing a reader the wrong list under a control they chose,
 * treating a multi-select as single, hiding a filter that is narrowing the
 * list, and forgetting all of it by the next visit.
 */
describe("the Marketplace's views and filters", () => {
  const CATALOGUE_FIXTURE: MarketplaceListing[] = [
    listing({ pluginId: "tipsy", displayName: "Tipsy", kind: "view", surfaces: ["work"] }),
    listing({ pluginId: "acme", displayName: "Acme", kind: "integration", official: true }),
    listing({ pluginId: "count", displayName: "Count", kind: "tool" }),
    listing({
      pluginId: "slate",
      displayName: "Slate",
      kind: "theme",
      isTheme: true,
      themeTokens: { dark: { "--color-accent": "#8899ff" } },
    }),
  ];

  beforeEach(() => {
    CATALOGUE.listings = CATALOGUE_FIXTURE;
    registry.plugins = [];
  });

  const chip = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });

  it("opens on Plugins and keeps themes out of it", async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());

    expect(screen.getByRole("radio", { name: "Plugins" }).getAttribute("aria-checked")).toBe("true");
    // The whole point of the split: a reader who came for an integration never
    // scrolls past a wall of colour packages.
    expect(screen.queryByText("Slate")).toBeNull();
    expect(screen.getByText("Acme")).toBeTruthy();
  });

  it("switches to a theme grid with the detail page's own verbs", async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Themes" }));
    });

    expect(screen.getByText("Slate")).toBeTruthy();
    expect(screen.queryByText("Acme")).toBeNull();
    // The same three words the detail rail uses, so the two screens teach one
    // vocabulary rather than two.
    expect(screen.getByText("Preview theme")).toBeTruthy();
    // The type and state axes belong to Plugins; a theme has no "Adds to".
    expect(screen.queryByRole("group", { name: "Filter by type" })).toBeNull();
  });

  it("ORs the type chips instead of replacing the selection", async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());

    await act(async () => {
      fireEvent.click(chip("Integrations"));
    });
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.queryByText("Count")).toBeNull();

    // A second type WIDENS. This is the difference from the old single-select
    // chip row, where pressing Tools would have thrown Integrations away.
    await act(async () => {
      fireEvent.click(chip("Tools"));
    });
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("Count")).toBeTruthy();
    expect(screen.queryByText("Tipsy")).toBeNull();

    await act(async () => {
      fireEvent.click(chip("Integrations"));
    });
    expect(screen.queryByText("Acme")).toBeNull();
    expect(screen.getByText("Count")).toBeTruthy();
  });

  it("keeps the state filter to one at a time, and lets the chosen one clear itself", async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());

    await act(async () => {
      fireEvent.click(chip("Official"));
    });
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.queryByText("Count")).toBeNull();

    // Community REPLACES Official rather than adding to it: "Official and
    // Community" is everything, so a multi-select here would mean nothing.
    await act(async () => {
      fireEvent.click(chip("Community"));
    });
    expect(screen.queryByText("Acme")).toBeNull();
    expect(screen.getByText("Count")).toBeTruthy();

    await act(async () => {
      fireEvent.click(chip("Community"));
    });
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("Count")).toBeTruthy();
  });

  it("hides the surface facets behind a disclosure and filters on them", async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());

    const toggle = screen.getByRole("button", { name: /Adds to/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Filter by what a plugin adds to" })).toBeNull();

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      fireEvent.click(chip("Work"));
    });
    expect(screen.getByText("Tipsy")).toBeTruthy();
    expect(screen.queryByText("Acme")).toBeNull();
  });

  it("opens the facets already expanded when a remembered filter is narrowing the list", async () => {
    // A filter narrowing the list from inside a closed section is the one state
    // this must never be in.
    storedQuery = { view: "plugins", types: [], state: "all", surfaces: ["work"], sort: "installs", sortDir: "desc" };
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());

    expect(screen.getByRole("button", { name: /Adds to/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByText("Acme")).toBeNull();
  });

  it("restores the remembered view and writes every change back", async () => {
    storedQuery = { view: "themes", types: [], state: "all", surfaces: [], sort: "new", sortDir: "asc" };
    renderGallery();
    await waitFor(() => expect(screen.getByText("Slate")).toBeTruthy());
    expect(screen.getByRole("radio", { name: "Themes" }).getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Plugins" }));
    });

    const last = storedWrites.at(-1) as { view: string; sort: string } | undefined;
    expect(last?.view).toBe("plugins");
    // The rest of the remembered query rides along: switching views is not a
    // reset.
    expect(last?.sort).toBe("new");
  });

  it("does not carry the search box across visits", async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search plugins"), { target: { value: "acme" } });
    });
    expect(screen.queryByText("Tipsy")).toBeNull();

    // The store is told about the filters, never about the word. A Marketplace
    // that opens with last week's search looks like one with three plugins in
    // it.
    for (const write of storedWrites) {
      expect((write as { search: string }).search).toBe("");
    }
  });

  it("clears the filters without leaving the view someone chose", async () => {
    renderGallery();
    await waitFor(() => expect(screen.getByText("Tipsy")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Themes" }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search plugins"), { target: { value: "nothing here" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Clear filters"));
    });
    expect(screen.getByRole("radio", { name: "Themes" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Slate")).toBeTruthy();
  });
});
