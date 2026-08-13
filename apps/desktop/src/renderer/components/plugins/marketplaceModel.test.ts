import { describe, expect, it } from "vitest";

import {
  DEFAULT_MARKETPLACE_QUERY,
  coverageSummary,
  deriveMachineCoverage,
  deriveSurfaceFacets,
  describePluginAdds,
  describePluginResources,
  describePluginSource,
  pluginAuthorUrl,
  pluginStoresData,
  describePluginStorage,
  installStateFor,
  installedPluginIds,
  listingFromInstalled,
  marketplaceRouteFromPath,
  mergeMarketplaceCatalogue,
  parseMarketplaceEntry,
  queryMarketplace,
  type MarketplaceListing,
} from "./marketplaceModel";
import { MARKETPLACE_LOCAL_INDEX } from "./marketplaceLocalIndex";
import { parsePluginManifest } from "../../../shared/plugins/manifest";
import type { InstalledPlugin, PluginPresenceRow, PluginUsageRow } from "../../lib/pluginRuntimeBridge";

/**
 * These cover the decisions the Marketplace makes about *facts* — what the
 * catalogue contains, what is installed where, what a plugin will add. The
 * rendering is deliberately not tested: the shape of a row changes with design
 * and asserting on it would only make the design harder to change.
 */

function listing(overrides: Partial<MarketplaceListing> = {}): MarketplaceListing {
  return {
    pluginId: "graph",
    displayName: "Graph",
    author: "ADE",
    description: "A graph.",
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
    source: "https://example.test/graph",
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
    pluginId: "graph",
    displayName: "Graph",
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

function presenceRow(overrides: Partial<PluginPresenceRow> = {}): PluginPresenceRow {
  return {
    machineKey: "mac-1",
    machineName: "Studio",
    pluginId: "graph",
    version: "1.0.0",
    enabled: true,
    online: true,
    isThisMachine: false,
    ...overrides,
  };
}

describe("parseMarketplaceEntry", () => {
  const repo = "https://github.com/ade-plugins/graph";

  it("keeps an entry whose optional fields are missing or malformed", () => {
    const parsed = parseMarketplaceEntry({
      pluginId: "graph",
      version: "1.2.0",
      repo,
      installs: "lots",
      stars: -4,
      publishedAt: "not a date",
      surfaces: ["lanes", "nowhere"],
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.installs).toBeNull();
    expect(parsed?.stars).toBeNull();
    expect(parsed?.publishedAt).toBeNull();
    expect(parsed?.surfaces).toEqual(["lanes"]);
    expect(parsed?.source).toBe(repo);
  });

  it("drops an entry the registry contract refuses", () => {
    expect(parseMarketplaceEntry({ pluginId: "Graph", version: "1.0.0", repo })).toBeNull();
    expect(parseMarketplaceEntry({ pluginId: "graph", version: "one", repo })).toBeNull();
    // No installable source: a row whose Install button cannot work is worse
    // than a row that is missing.
    expect(parseMarketplaceEntry({ pluginId: "graph", version: "1.0.0" })).toBeNull();
    expect(parseMarketplaceEntry("graph")).toBeNull();
  });

  it("carries the directory's own summary as the fallback Adds list", () => {
    const parsed = parseMarketplaceEntry({
      pluginId: "swatch",
      version: "1.0.0",
      repo: "https://github.com/ade-plugins/swatch",
      isTheme: true,
      adds: ["A colour theme"],
    });

    // A directory entry publishes no manifest, so the modal shows what the
    // directory said rather than deriving counts it does not have.
    expect(parsed?.manifest).toBeNull();
    expect(parsed?.isTheme).toBe(true);
    expect(describePluginAdds(parsed!)).toEqual(["A colour theme"]);
  });
});

describe("mergeMarketplaceCatalogue", () => {
  it("prefers a directory entry over the bundled copy of the same plugin", () => {
    const merged = mergeMarketplaceCatalogue({
      bundled: [listing({ version: "1.0.0", description: "Shipped copy.", origin: "bundled" })],
      live: [listing({ version: "2.0.0", description: "Published copy." })],
      installed: [],
    });

    expect(merged.listings).toHaveLength(1);
    expect(merged.listings[0]?.version).toBe("2.0.0");
    expect(merged.listings[0]?.origin).toBe("directory");
  });

  it("keeps a plugin that is installed but in no catalogue", () => {
    const merged = mergeMarketplaceCatalogue({
      bundled: [],
      live: [],
      installed: [installedPlugin({ pluginId: "homegrown", displayName: "Homegrown" })],
    });

    expect(merged.listings.map((entry) => entry.pluginId)).toEqual(["homegrown"]);
    expect(merged.listings[0]?.origin).toBe("installed");
    expect(merged.listings[0]?.installs).toBeNull();
  });

  it("reports a failed fetch as stale rather than as an empty catalogue", () => {
    const merged = mergeMarketplaceCatalogue({
      bundled: [listing()],
      live: null,
      installed: [],
    });

    expect(merged.state).toEqual({ kind: "stale" });
    expect(merged.listings).toHaveLength(1);
  });

  it("distinguishes a host that cannot browse from one whose fetch failed", () => {
    const merged = mergeMarketplaceCatalogue({
      bundled: [listing()],
      live: null,
      installed: [],
      browseSupported: false,
    });

    expect(merged.state).toEqual({ kind: "unsupported" });
  });
});

describe("installStateFor", () => {
  it("reports an update when the catalogue is ahead of the installed version", () => {
    const state = installStateFor(listing({ version: "1.4.0" }), [installedPlugin({ version: "1.2.0" })]);
    expect(state).toEqual({ kind: "update", version: "1.2.0", available: "1.4.0" });
  });

  it("does not report an update when the installed copy is ahead", () => {
    const state = installStateFor(listing({ version: "1.0.0" }), [installedPlugin({ version: "1.1.0" })]);
    expect(state).toEqual({ kind: "installed", version: "1.1.0" });
  });

  it("separates turned-off from not-installed", () => {
    expect(installStateFor(listing(), [installedPlugin({ enabled: false })]))
      .toEqual({ kind: "disabled", version: "1.0.0" });
    expect(installStateFor(listing(), [])).toEqual({ kind: "available" });
  });
});

describe("queryMarketplace", () => {
  const catalogue = [
    listing({ pluginId: "graph", displayName: "Graph", official: true, installs: 40, stars: 2, surfaces: ["lanes"] }),
    listing({ pluginId: "history", displayName: "History", featured: true, installs: 900, stars: null, surfaces: ["work"] }),
    listing({ pluginId: "slate-theme", displayName: "Slate", isTheme: true, installs: null, publishedAt: "2026-08-01T00:00:00Z" }),
    listing({ pluginId: "beacon", displayName: "Beacon", author: "Ann", installs: 5, publishedAt: "2026-01-01T00:00:00Z" }),
  ];

  it("requires every search word to match, across name, id, author and description", () => {
    const found = queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, search: "beacon ann" });
    expect(found.map((entry) => entry.pluginId)).toEqual(["beacon"]);
    expect(queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, search: "beacon zed" })).toEqual([]);
  });

  it("filters by chip", () => {
    expect(queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, chip: "official" })
      .map((entry) => entry.pluginId)).toEqual(["graph"]);
    expect(queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, chip: "themes" })
      .map((entry) => entry.pluginId)).toEqual(["slate-theme"]);
  });

  it("keeps only what is installed on this machine under the installed chip", () => {
    const installed = installedPluginIds([
      installedPlugin({ pluginId: "history" }),
      // Turned off still counts as installed: the chip answers "do I have it",
      // not "is it running".
      installedPlugin({ pluginId: "slate-theme", enabled: false }),
    ]);
    const found = queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, chip: "installed" }, installed);
    expect(found.map((entry) => entry.pluginId)).toEqual(["history", "slate-theme"]);
  });

  it("keeps nothing under the installed chip when no set is supplied", () => {
    // The default matters: a caller that forgets the set must show an empty
    // list rather than silently showing the whole catalogue as installed.
    expect(queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, chip: "installed" })).toEqual([]);
  });

  it("scopes the surface facets to the installed chip", () => {
    const facets = deriveSurfaceFacets(
      catalogue,
      { ...DEFAULT_MARKETPLACE_QUERY, chip: "installed" },
      installedPluginIds([installedPlugin({ pluginId: "graph" })]),
    );
    expect(facets).toEqual([{ surface: "lanes", label: "Lanes", total: 1 }]);
  });

  it("keeps only listings that extend every selected surface", () => {
    const found = queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, surfaces: ["lanes"] });
    expect(found.map((entry) => entry.pluginId)).toEqual(["graph"]);
    expect(queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, surfaces: ["lanes", "work"] })).toEqual([]);
  });

  it("sorts unknown counts last rather than as zero", () => {
    const byInstalls = queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, sort: "installs" });
    expect(byInstalls.map((entry) => entry.pluginId)).toEqual(["history", "graph", "beacon", "slate-theme"]);

    const byStars = queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, sort: "stars" });
    expect(byStars[0]?.pluginId).toBe("graph");
    expect(byStars.slice(1).map((entry) => entry.displayName)).toEqual(["Beacon", "History", "Slate"]);
  });

  it("sorts newest first and puts undated entries last", () => {
    const byNew = queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, sort: "new" });
    expect(byNew.map((entry) => entry.pluginId).slice(0, 2)).toEqual(["slate-theme", "beacon"]);
  });

  it("counts facets against the chip and search but not the facet selection", () => {
    const facets = deriveSurfaceFacets(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, surfaces: ["lanes"] });
    expect(facets).toEqual([
      { surface: "work", label: "Work", total: 1 },
      { surface: "lanes", label: "Lanes", total: 1 },
    ]);
  });
});

describe("describePluginAdds", () => {
  it("counts what the manifest declares rather than what the listing claims", () => {
    const { manifest } = parsePluginManifest({
      name: "graph",
      version: "1.0.0",
      displayName: "Graph",
      description: "",
      entry: "index.js",
      surfaces: [{ kind: "tab", id: "graph", title: "Graph", panelId: "main" }],
      sockets: [
        { socket: "row-badge", surface: "prs", id: "a", label: "Risk" },
        { socket: "row-badge", surface: "prs", id: "b", label: "Size" },
      ],
      cli: ["show"],
      skills: ["skills/x"],
      collections: { nodes: { sync: true } },
    });
    const entry = listing({ manifest, addsSummary: ["Everything you could ever want"] });

    expect(describePluginAdds(entry)).toEqual([
      "Graph tab",
      "2 additions to PRs",
      "Terminal commands: ade graph show",
      "One agent skill",
      "Stores data, and syncs it to your other devices",
      "Runs code on this machine",
    ]);
  });

  it("falls back to the catalogue summary when there is no manifest", () => {
    expect(describePluginAdds(listing({ addsSummary: ["A tab"] }))).toEqual(["A tab"]);
    expect(describePluginAdds(listing({ isTheme: true }))).toEqual(["A colour theme"]);
    expect(describePluginAdds(listing())).toEqual([]);
  });
});

/** 2 MB and 4,000 items, the budgets the host reports today. */
function usageRow(overrides: Partial<PluginUsageRow> = {}): PluginUsageRow {
  return {
    pluginId: "graph",
    collectionBytes: 0,
    collectionBudgetBytes: 2 * 1024 * 1024,
    rows: 0,
    rowBudget: 4000,
    syncBytesTotal: 0,
    ...overrides,
  };
}

describe("pluginStoresData", () => {
  function manifestFor(raw: Record<string, unknown>) {
    const { manifest } = parsePluginManifest({
      name: "graph",
      version: "1.0.0",
      displayName: "Graph",
      description: "",
      ...raw,
    });
    return manifest;
  }

  it("says no for a plugin that declares no storage and holds none", () => {
    // The manifest-only case the section is hidden for: a theme reports zeroes
    // forever because it has nowhere to put anything.
    expect(pluginStoresData(manifestFor({ theme: { tokens: { dark: {} } } }), usageRow())).toBe(false);
    expect(pluginStoresData(null, usageRow())).toBe(false);
    expect(pluginStoresData(null, null)).toBe(false);
  });

  it("says yes for a declared collection, and for a panel bound to a schema", () => {
    expect(pluginStoresData(manifestFor({ collections: { nodes: { sync: false } } }), usageRow())).toBe(true);
    expect(pluginStoresData(
      manifestFor({ panels: [{ id: "main", schemaFile: "schema/main.json" }] }),
      usageRow(),
    )).toBe(true);
  });

  it("says yes on any nonzero usage, whatever the manifest declares", () => {
    expect(pluginStoresData(null, usageRow({ collectionBytes: 12 }))).toBe(true);
    expect(pluginStoresData(null, usageRow({ rows: 1 }))).toBe(true);
    expect(pluginStoresData(null, usageRow({ syncBytesTotal: 40 }))).toBe(true);
    // Unmetered sync is not evidence of storage.
    expect(pluginStoresData(null, usageRow({ syncBytesTotal: null }))).toBe(false);
  });
});

describe("describePluginStorage", () => {
  it("stays quiet and numberless well below the ceiling", () => {
    const report = describePluginStorage(usageRow({ collectionBytes: 86_016, rows: 120 }));
    expect(report.level).toBe("healthy");
    expect(report.summary).toBe("Keeps a small amount of data in sync across your devices.");
    // The resting line must not quote a figure — that is the whole point of it.
    expect(report.summary).not.toMatch(/\d/);
  });

  it("speaks up at 70% of either budget and goes red at 100%", () => {
    const bytesBudget = 2 * 1024 * 1024;
    expect(describePluginStorage(usageRow({ collectionBytes: bytesBudget * 0.7 })).level).toBe("nearly-full");
    expect(describePluginStorage(usageRow({ rows: 2800 })).level).toBe("nearly-full");
    // Just under the line is still the quiet state.
    expect(describePluginStorage(usageRow({ rows: 2799 })).level).toBe("healthy");
    expect(describePluginStorage(usageRow({ collectionBytes: bytesBudget })).level).toBe("full");
    expect(describePluginStorage(usageRow({ rows: 4000 })).level).toBe("full");
    // The worse of the two decides: one full budget is a full plugin.
    expect(describePluginStorage(usageRow({ rows: 4000, collectionBytes: 0 })).level).toBe("full");
  });

  it("quotes whichever budget is actually running out", () => {
    // Bytes comfortable, items nearly gone: quoting the bytes here would be a
    // true number that answers the wrong question.
    const byItems = describePluginStorage(usageRow({ collectionBytes: 1024, rows: 3200 }));
    expect(byItems.summary).toBe("Its synced space is getting full (3,200 of 4,000 saved items).");

    const byBytes = describePluginStorage(usageRow({ collectionBytes: 1.6 * 1024 * 1024, rows: 10 }));
    expect(byBytes.summary).toBe("Its synced space is getting full (1.6 MB of 2.0 MB).");
  });

  it("says a full plugin still works rather than that it is broken", () => {
    const report = describePluginStorage(usageRow({ rows: 4200 }));
    expect(report.summary).toBe("Its synced space is full. It can't save new synced data until it frees some.");
    expect(report.summary).not.toMatch(/broken|error|failed/i);
  });

  it("puts the numbers in the details, and omits sync when it is unmetered", () => {
    const metered = describePluginStorage(usageRow({
      collectionBytes: 86_016,
      rows: 120,
      syncBytesTotal: 1.2 * 1024 * 1024,
    }));
    expect(metered.details).toEqual([
      { label: "Space used", value: "84 KB of 2.0 MB" },
      { label: "Saved items", value: "120 of 4,000" },
      { label: "Sent to your devices", value: "1.2 MB" },
    ]);

    const unmetered = describePluginStorage(usageRow({ syncBytesTotal: null }));
    expect(unmetered.details.map((detail) => detail.label)).toEqual(["Space used", "Saved items"]);
  });

  it("treats a missing budget as unknown rather than as full", () => {
    // A host that reports no ceiling must not paint every plugin red.
    const report = describePluginStorage(usageRow({
      collectionBytes: 900,
      collectionBudgetBytes: 0,
      rows: 12,
      rowBudget: 0,
    }));
    expect(report.level).toBe("healthy");
  });
});

describe("deriveMachineCoverage", () => {
  it("reads this machine from the local registry, not from presence", () => {
    // Presence lags a fresh install by a round trip; the local registry must win.
    const rows = deriveMachineCoverage({
      pluginId: "graph",
      catalogueVersion: "1.0.0",
      presence: [presenceRow({ machineKey: "mine", pluginId: "other", isThisMachine: true })],
      installed: [installedPlugin()],
      thisMachineKey: "mine",
    });

    expect(rows[0]?.isThisMachine).toBe(true);
    expect(rows[0]?.state).toBe("installed");
  });

  it("calls an unreachable machine unknown rather than missing", () => {
    const rows = deriveMachineCoverage({
      pluginId: "graph",
      catalogueVersion: null,
      presence: [presenceRow({ machineKey: "away", pluginId: "other", online: false })],
      installed: [],
      thisMachineKey: "mine",
    });

    const away = rows.find((row) => row.machineKey === "away");
    expect(away?.state).toBe("unknown");
    expect(coverageSummary(rows)).toEqual({ present: 0, total: 1, unknown: 1 });
  });

  it("marks a machine behind the catalogue version as outdated", () => {
    const rows = deriveMachineCoverage({
      pluginId: "graph",
      catalogueVersion: "2.0.0",
      presence: [presenceRow({ machineKey: "away", version: "1.0.0" })],
      installed: [],
      thisMachineKey: "mine",
    });

    expect(rows.find((row) => row.machineKey === "away")?.state).toBe("outdated");
  });

  it("shows a single machine when the host publishes no presence at all", () => {
    const rows = deriveMachineCoverage({
      pluginId: "graph",
      catalogueVersion: null,
      presence: [],
      installed: [installedPlugin({ enabled: false })],
      thisMachineKey: null,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.isThisMachine).toBe(true);
    expect(rows[0]?.state).toBe("disabled");
  });

  it("puts this machine first, then reachable machines", () => {
    const rows = deriveMachineCoverage({
      pluginId: "graph",
      catalogueVersion: null,
      presence: [
        presenceRow({ machineKey: "zed", machineName: "Zed", online: true }),
        presenceRow({ machineKey: "away", machineName: "Away", online: false }),
        presenceRow({ machineKey: "mine", machineName: "Mine", isThisMachine: true }),
      ],
      installed: [],
      thisMachineKey: "mine",
    });

    expect(rows.map((row) => row.machineKey)).toEqual(["mine", "zed", "away"]);
  });
});

describe("marketplaceRouteFromPath", () => {
  it("reads a plugin id and refuses anything that is not one", () => {
    expect(marketplaceRouteFromPath("/marketplace")).toEqual({ pluginId: null });
    expect(marketplaceRouteFromPath("/marketplace/graph")).toEqual({ pluginId: "graph" });
    expect(marketplaceRouteFromPath("/marketplace/graph/extra")).toEqual({ pluginId: "graph" });
    expect(marketplaceRouteFromPath("/marketplace/..")).toEqual({ pluginId: null });
    expect(marketplaceRouteFromPath("/marketplace/Graph")).toEqual({ pluginId: null });
  });
});

describe("the bundled index", () => {
  it("carries a manifest whose identity matches the listing", () => {
    for (const entry of MARKETPLACE_LOCAL_INDEX) {
      expect(entry.manifest?.name).toBe(entry.pluginId);
      expect(entry.manifest?.version).toBe(entry.version);
      expect(entry.origin).toBe("bundled");
    }
  });

  it("publishes no install counts it has not measured", () => {
    for (const entry of MARKETPLACE_LOCAL_INDEX) {
      expect(entry.installs).toBeNull();
      expect(entry.stars).toBeNull();
    }
  });

  it("gives every bundled theme both palettes", () => {
    const themes = MARKETPLACE_LOCAL_INDEX.filter((entry) => entry.isTheme);
    expect(themes.length).toBeGreaterThan(0);
    for (const theme of themes) {
      // A dark-only theme silently reverts half of itself on a light base.
      expect(Object.keys(theme.themeTokens?.dark ?? {}).length).toBeGreaterThan(0);
      expect(Object.keys(theme.themeTokens?.light ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("survives the merge without a live directory", () => {
    const merged = mergeMarketplaceCatalogue({
      bundled: MARKETPLACE_LOCAL_INDEX,
      live: null,
      installed: [],
    });
    expect(merged.listings).toHaveLength(MARKETPLACE_LOCAL_INDEX.length);
    expect(queryMarketplace(merged.listings, { ...DEFAULT_MARKETPLACE_QUERY, chip: "themes" }).length)
      .toBe(MARKETPLACE_LOCAL_INDEX.filter((entry) => entry.isTheme).length);
  });
});

describe("listingFromInstalled", () => {
  it("carries the theme tokens so a sideloaded theme can still be previewed", () => {
    const entry = listingFromInstalled(installedPlugin({
      pluginId: "mine",
      theme: { displayName: "Mine", tokens: { dark: { "--color-accent": "#fff" } } },
    }));

    expect(entry.isTheme).toBe(true);
    expect(entry.themeTokens).toEqual({ dark: { "--color-accent": "#fff" } });
  });
});

describe("marketplaceRouteFromPath", () => {
  it("falls back to the gallery for a link it cannot decode", () => {
    // `decodeURIComponent` throws on a malformed escape, and the route parser
    // runs during render — an uncaught throw here takes the page, not the link.
    expect(marketplaceRouteFromPath("/marketplace/%zz")).toEqual({ pluginId: null });
    expect(marketplaceRouteFromPath("/marketplace/%E0%A4%A")).toEqual({ pluginId: null });
    expect(marketplaceRouteFromPath("/marketplace/lane-graph")).toEqual({ pluginId: "lane-graph" });
    expect(marketplaceRouteFromPath("/marketplace")).toEqual({ pluginId: null });
  });
});

describe("describePluginSource", () => {
  it("offers a link only for a source a browser can actually open", () => {
    expect(describePluginSource("https://github.com/acme/lane-graph.git")).toEqual({
      text: "github.com/acme/lane-graph",
      url: "https://github.com/acme/lane-graph.git",
    });
    // An SSH remote and a local folder are real sources with no page behind
    // them; a "View source" button on either would go nowhere.
    expect(describePluginSource("git@github.com:acme/lane-graph.git")).toEqual({
      text: "github.com/acme/lane-graph",
      url: null,
    });
    expect(describePluginSource("/Users/sam/code/lane-graph")).toEqual({
      text: "…/code/lane-graph",
      url: null,
    });
    expect(describePluginSource("C:\\Users\\sam\\lane-graph")).toEqual({
      text: "…/sam/lane-graph",
      url: null,
    });
    expect(describePluginSource("   ")).toBeNull();
  });
});

describe("resources and authorship", () => {
  it("names the owner's page rather than the author's own text", () => {
    expect(pluginAuthorUrl(listing({ repo: "https://github.com/arul28/ade-graph" })))
      .toBe("https://github.com/arul28");
    // A plugin installed from a folder has no page, and an http repo is not one
    // this app is willing to open.
    expect(pluginAuthorUrl(listing({ repo: null, links: null }))).toBeNull();
    expect(pluginAuthorUrl(listing({ repo: "http://github.com/arul28/ade-graph" }))).toBeNull();
    expect(pluginAuthorUrl(listing({ repo: "not a url" }))).toBeNull();
  });

  it("builds the rail in reading order and never lists one URL twice", () => {
    const rail = describePluginResources(listing({
      repo: "https://github.com/arul28/ade-graph",
      source: "https://github.com/arul28/ade-graph",
      changelogUrl: "https://github.com/arul28/ade-graph/releases",
      links: {
        repository: "https://github.com/arul28/ade-graph",
        homepage: "https://ade.example",
        changelog: null,
        license: null,
        docs: "https://docs.example/graph",
      },
    }));
    expect(rail).toEqual([
      { label: "View source", url: "https://github.com/arul28/ade-graph" },
      { label: "Homepage", url: "https://ade.example" },
      { label: "Documentation", url: "https://docs.example/graph" },
      { label: "Changelog", url: "https://github.com/arul28/ade-graph/releases" },
    ]);
  });

  it("adds the install source only when it is somewhere else", () => {
    const rail = describePluginResources(listing({
      repo: "https://github.com/arul28/ade-graph",
      source: "https://mirror.example/ade-graph.git",
      changelogUrl: null,
      links: null,
    }));
    expect(rail).toEqual([
      { label: "View source", url: "https://github.com/arul28/ade-graph" },
      { label: "Install source", url: "https://mirror.example/ade-graph.git" },
    ]);
  });

  it("has nothing to show for a plugin installed from a folder", () => {
    expect(describePluginResources(listing({
      repo: null,
      links: null,
      changelogUrl: null,
      source: "/Users/sam/code/lane-graph",
    }))).toEqual([]);
  });
});
