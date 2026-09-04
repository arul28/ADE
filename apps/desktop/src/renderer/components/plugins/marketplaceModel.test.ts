import { describe, expect, it } from "vitest";

import {
  DEFAULT_MARKETPLACE_QUERY,
  coverageSummary,
  derivePluginKind,
  deriveMachineCoverage,
  deriveSurfaceFacets,
  deriveTypeFacets,
  describePluginAdds,
  describePluginDownload,
  describePluginResources,
  describePluginSource,
  pluginAuthorUrl,
  pluginStoresData,
  describePluginStorage,
  installStateFor,
  installedPluginIds,
  listingFromInstalled,
  marketplaceFiltersActive,
  marketplaceInstallIndex,
  marketplaceRouteFromPath,
  mergeMarketplaceCatalogue,
  normalizeMarketplaceQuery,
  parseMarketplaceEntry,
  queryMarketplace,
  sameMarketplaceFilters,
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
    kind: "view",
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
      sizeBytes: "4 MB",
      publishedAt: "not a date",
      surfaces: ["lanes", "nowhere"],
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.installs).toBeNull();
    expect(parsed?.stars).toBeNull();
    expect(parsed?.sizeBytes).toBeNull();
    expect(parsed?.extraDownloads).toEqual([]);
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

describe("describePluginDownload", () => {
  it("quotes the package and anything the plugin fetches later, separately", () => {
    const report = describePluginDownload(listing({
      sizeBytes: 4_404_019,
      extraDownloads: [{ label: "Speech model", bytes: 147_800_000 }],
    }));

    expect(report.size).toBe("4.2 MB");
    // Not summed with the package: the second download happens later and only
    // for people who use the feature, and one combined figure would say
    // neither of those things.
    expect(report.extras).toEqual([
      "Downloads a further 141 MB (Speech model) the first time you use it.",
    ]);
  });

  it("renders nothing at all for a size nobody measured", () => {
    // The whole point of the null: "0 B" is a measurement, and an unmeasured
    // plugin has not been measured as weighing nothing.
    for (const value of [undefined, null, 0]) {
      expect(describePluginDownload(listing({ sizeBytes: value })).size).toBeNull();
    }
    expect(describePluginDownload(listing()).extras).toEqual([]);
  });

  it("describes each extra download a plugin declares", () => {
    const report = describePluginDownload(listing({
      extraDownloads: [
        { label: "Speech model", bytes: 147_800_000 },
        { label: "Language pack", bytes: 8 * 1024 * 1024 },
      ],
    }));
    expect(report.size).toBeNull();
    expect(report.extras).toEqual([
      "Downloads a further 141 MB (Speech model) the first time you use it.",
      "Downloads a further 8.0 MB (Language pack) the first time you use it.",
    ]);
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

  /**
   * The registry index that shipped first listed every official plugin at a
   * version OLDER than the copy inside the app, pointing at repositories with
   * no manifest. Unconditional directory precedence made the gallery offer a
   * downgrade and blanked the install dialog's Adds list.
   */
  it("keeps the bundled copy when the directory entry is behind it", () => {
    const { manifest } = parsePluginManifest({
      name: "graph",
      version: "1.1.0",
      displayName: "Graph",
      description: "",
      surfaces: [{ kind: "tab", id: "graph", title: "Graph", panelId: "main" }],
    });

    const merged = mergeMarketplaceCatalogue({
      bundled: [listing({ version: "1.1.0", source: "graph", manifest, origin: "bundled" })],
      live: [listing({ version: "1.0.1", source: "https://example.test/graph", installs: 42, stars: 7, publishedAt: "2026-08-14T00:00:00.000Z" })],
      installed: [],
    });

    expect(merged.listings).toHaveLength(1);
    const entry = merged.listings[0];
    expect(entry?.version).toBe("1.1.0");
    expect(entry?.origin).toBe("bundled");
    // Installing must fetch the bundled package, not the older repository.
    expect(entry?.source).toBe("graph");
    expect(entry?.manifest).toBe(manifest);
    // Winning on version must not empty the card.
    expect(entry?.installs).toBe(42);
    expect(entry?.stars).toBe(7);
    expect(entry?.publishedAt).toBe("2026-08-14T00:00:00.000Z");
  });

  it("lets the directory win when it is ahead of the bundled copy", () => {
    const { manifest } = parsePluginManifest({
      name: "graph",
      version: "1.0.1",
      displayName: "Graph",
      description: "",
    });

    const merged = mergeMarketplaceCatalogue({
      bundled: [listing({ version: "1.0.1", source: "graph", manifest, origin: "bundled" })],
      live: [listing({ version: "1.1.0", source: "https://example.test/graph" })],
      installed: [],
    });

    expect(merged.listings[0]?.version).toBe("1.1.0");
    expect(merged.listings[0]?.origin).toBe("directory");
    expect(merged.listings[0]?.source).toBe("https://example.test/graph");
    // A newer published manifest is unknown, so the dialog says it reads one
    // during install rather than describing the older bundled package.
    expect(merged.listings[0]?.manifest).toBeNull();
  });

  it("lends the bundled manifest to a directory entry at the same version", () => {
    const { manifest } = parsePluginManifest({
      name: "graph",
      version: "1.1.0",
      displayName: "Graph",
      description: "",
      surfaces: [{ kind: "tab", id: "graph", title: "Graph", panelId: "main" }],
    });

    const merged = mergeMarketplaceCatalogue({
      bundled: [listing({ version: "1.1.0", manifest, origin: "bundled" })],
      live: [listing({ version: "1.1.0", description: "Published copy." })],
      installed: [],
    });

    expect(merged.listings[0]?.origin).toBe("directory");
    expect(merged.listings[0]?.description).toBe("Published copy.");
    expect(merged.listings[0]?.manifest).toBe(manifest);
    expect(describePluginAdds(merged.listings[0]!)).not.toHaveLength(0);
  });

  /**
   * The Marketplace's theme preview reads `themeTokens`, and only the BUNDLED
   * listing has any: `listingFromRegistryEntry` hardcodes `themeTokens: null`
   * because a directory row is a listing, not a package. Publishing Ink at the
   * version already inside the app therefore replaced the one listing that
   * could paint a preview with one that could not, and Preview theme went
   * blank for a theme that ships in the binary.
   */
  it("lends the bundled theme tokens to a published theme at the same version", () => {
    const ink = MARKETPLACE_LOCAL_INDEX.find((entry) => entry.pluginId === "ade-theme-ink");
    expect(ink?.themeTokens?.dark).toBeTruthy();

    const merged = mergeMarketplaceCatalogue({
      bundled: [{ ...ink!, origin: "bundled" }],
      // What the directory publishes: same id, same version, no tokens.
      live: [listing({
        pluginId: "ade-theme-ink",
        displayName: "Ink",
        version: ink!.version,
        isTheme: true,
        manifest: null,
        themeTokens: null,
        description: "Published copy.",
      })],
      installed: [],
    });

    const entry = merged.listings[0];
    expect(entry?.origin).toBe("directory");
    expect(entry?.description).toBe("Published copy.");
    expect(entry?.themeTokens).toEqual(ink!.themeTokens);
    expect(entry?.manifest).toBe(ink!.manifest);
  });

  it("falls back to the bundled manifest's own tokens when the listing has none", () => {
    const ink = MARKETPLACE_LOCAL_INDEX.find((entry) => entry.pluginId === "ade-theme-ink");

    const merged = mergeMarketplaceCatalogue({
      bundled: [{ ...ink!, themeTokens: null, origin: "bundled" }],
      live: [listing({ pluginId: "ade-theme-ink", version: ink!.version, isTheme: true, themeTokens: null })],
      installed: [],
    });

    expect(merged.listings[0]?.themeTokens).toEqual(ink!.manifest?.theme?.tokens);
  });

  it("treats an unparsable directory version as lower than a real one", () => {
    const merged = mergeMarketplaceCatalogue({
      bundled: [listing({ version: "1.1.0", source: "graph", origin: "bundled" })],
      live: [listing({ version: "latest", source: "https://example.test/graph" })],
      installed: [],
    });

    expect(merged.listings[0]?.version).toBe("1.1.0");
    expect(merged.listings[0]?.origin).toBe("bundled");
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

describe("derivePluginKind", () => {
  const manifestOf = (partial: Record<string, unknown>) => {
    const { manifest } = parsePluginManifest({
      name: "probe",
      version: "1.0.0",
      displayName: "Probe",
      description: "",
      ...partial,
    });
    if (!manifest) throw new Error("fixture manifest did not parse");
    return manifest;
  };

  it("files a palette as a theme whatever else it declares", () => {
    const manifest = manifestOf({
      theme: { displayName: "Ember", tokens: { dark: { "--color-accent": "#f00" } } },
      cli: ["ember"],
      network: { hosts: ["example.test"] },
    });
    expect(derivePluginKind({ manifest, isTheme: true })).toBe("theme");
  });

  it("files anything that reaches outside this machine as an integration", () => {
    // Each of the four on its own is enough: a sign-in flow, an allowed host, a
    // webhook channel, or a URL shape it claims.
    expect(derivePluginKind({
      manifest: manifestOf({
        authSessions: [{
          id: "login",
          provider: "acme",
          authorizeUrl: "https://acme.test/oauth/authorize",
          callbacks: ["app"],
        }],
      }),
      isTheme: false,
    })).toBe("integration");
    expect(derivePluginKind({
      manifest: manifestOf({ network: { hosts: ["acme.test"] } }),
      isTheme: false,
    })).toBe("integration");
    expect(derivePluginKind({
      manifest: manifestOf({ webhookIngress: [{ id: "acme", label: "Acme events" }] }),
      isTheme: false,
    })).toBe("integration");
    expect(derivePluginKind({
      manifest: manifestOf({
        panels: [{ id: "issue" }],
        urlMatchers: [{
          id: "issue",
          hosts: ["acme.test"],
          pathPattern: "/issue/{key}",
          chip: { label: "{key}" },
          panelId: "issue",
        }],
      }),
      isTheme: false,
    })).toBe("integration");
  });

  it("files verbs without a tab as a tool, and verbs WITH a tab as a view", () => {
    const verbs = {
      tools: [{
        name: "count",
        description: "Counts.",
        input: { type: "object", properties: {} },
        action: "count",
      }],
    };
    expect(derivePluginKind({ manifest: manifestOf(verbs), isTheme: false })).toBe("tool");

    // The "no tab" half is what keeps the chip honest: nearly every plugin with
    // a page also ships a couple of tools, and filing those under Tools would
    // leave the chip meaning nothing.
    expect(derivePluginKind({
      manifest: manifestOf({
        ...verbs,
        surfaces: [{ kind: "tab", id: "main", title: "Probe", panelId: "main" }],
      }),
      isTheme: false,
    })).toBe("view");
    // A webview IS the rail tab — see `pluginRailTabSurface`. Splitting on
    // `kind === "tab"` alone would file every page plugin as a tool.
    expect(derivePluginKind({
      manifest: manifestOf({
        ...verbs,
        surfaces: [{ kind: "webview", id: "main", title: "Probe", panelId: "main", entryHtml: "dist/index.html" }],
      }),
      isTheme: false,
    })).toBe("view");
  });

  it("counts CLI words and automation steps as verbs too", () => {
    expect(derivePluginKind({ manifest: manifestOf({ cli: ["probe"] }), isTheme: false })).toBe("tool");
    expect(derivePluginKind({
      manifest: manifestOf({ automationSteps: [{ id: "ping", label: "Ping", action: "ping" }] }),
      isTheme: false,
    })).toBe("tool");
  });

  it("falls back to view for a package that declares nothing notable", () => {
    expect(derivePluginKind({ manifest: manifestOf({}), isTheme: false })).toBe("view");
  });

  it("can only tell theme from view without a manifest", () => {
    // A directory entry carries a summary, not the package. Guessing further
    // would file a sign-in flow under Views on the strength of nothing.
    expect(derivePluginKind({ manifest: null, isTheme: true })).toBe("theme");
    expect(derivePluginKind({ manifest: null, isTheme: false })).toBe("view");
  });

  it("re-derives after the merge hands a live entry the bundled manifest", () => {
    const manifest = manifestOf({ network: { hosts: ["acme.test"] } });
    const merged = mergeMarketplaceCatalogue({
      bundled: [listing({ pluginId: "probe", version: "1.0.0", manifest, kind: "integration", origin: "bundled" })],
      live: [listing({ pluginId: "probe", version: "1.0.0", manifest: null, kind: "view" })],
      installed: [],
    });
    // The live entry won on the tie and inherited the manifest, so what it IS
    // changed with it.
    expect(merged.listings[0]?.kind).toBe("integration");
  });

  it("gives every bundled official plugin a kind the type chips can find", () => {
    for (const entry of MARKETPLACE_LOCAL_INDEX) {
      expect(entry.kind).toBe(derivePluginKind(entry));
      expect(entry.isTheme).toBe(entry.kind === "theme");
    }
  });
});

describe("queryMarketplace", () => {
  const catalogue = [
    listing({ pluginId: "graph", displayName: "Graph", official: true, installs: 40, stars: 2, surfaces: ["lanes"] }),
    listing({ pluginId: "history", displayName: "History", featured: true, installs: 900, stars: null, surfaces: ["work"] }),
    listing({ pluginId: "slate-theme", displayName: "Slate", isTheme: true, kind: "theme", installs: null, publishedAt: "2026-08-01T00:00:00Z" }),
    listing({ pluginId: "beacon", displayName: "Beacon", author: "Ann", installs: 5, publishedAt: "2026-01-01T00:00:00Z" }),
  ];

  const index = (installed: readonly InstalledPlugin[]) =>
    marketplaceInstallIndex(catalogue, installed);

  it("requires every search word to match, across name, id, author and description", () => {
    const found = queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, search: "beacon ann" });
    expect(found.map((entry) => entry.pluginId)).toEqual(["beacon"]);
    expect(queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, search: "beacon zed" })).toEqual([]);
  });

  it("keeps themes out of the Plugins view and everything else out of Themes", () => {
    // The whole point of the split: the default view is not "all", and a reader
    // who came for an integration never scrolls past ten colour packages.
    expect(queryMarketplace(catalogue, DEFAULT_MARKETPLACE_QUERY).map((entry) => entry.pluginId))
      .toEqual(["history", "graph", "beacon"]);
    expect(queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, view: "themes" })
      .map((entry) => entry.pluginId)).toEqual(["slate-theme"]);
  });

  it("ORs the type chips within their own axis", () => {
    const typed = [
      listing({ pluginId: "acme", displayName: "Acme", kind: "integration" }),
      listing({ pluginId: "count", displayName: "Count", kind: "tool" }),
      listing({ pluginId: "board", displayName: "Board", kind: "view" }),
    ];
    expect(queryMarketplace(typed, { ...DEFAULT_MARKETPLACE_QUERY, types: [] })
      .map((entry) => entry.pluginId)).toEqual(["acme", "board", "count"]);
    expect(queryMarketplace(typed, { ...DEFAULT_MARKETPLACE_QUERY, types: ["tool"] })
      .map((entry) => entry.pluginId)).toEqual(["count"]);
    expect(queryMarketplace(typed, { ...DEFAULT_MARKETPLACE_QUERY, types: ["tool", "integration"] })
      .map((entry) => entry.pluginId)).toEqual(["acme", "count"]);
  });

  it("splits official from community under the state filter", () => {
    expect(queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, state: "official" })
      .map((entry) => entry.pluginId)).toEqual(["graph"]);
    expect(queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, state: "community" })
      .map((entry) => entry.pluginId)).toEqual(["history", "beacon"]);
  });

  it("keeps only what is installed on this machine under the installed state", () => {
    const installed = index([
      installedPlugin({ pluginId: "history" }),
      // Turned off still counts as installed: the filter answers "do I have
      // it", not "is it running".
      installedPlugin({ pluginId: "beacon", enabled: false }),
    ]);
    const found = queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, state: "installed" }, installed);
    expect(found.map((entry) => entry.pluginId)).toEqual(["history", "beacon"]);
  });

  it("keeps only what the catalogue has a newer version of under the updates state", () => {
    // The comparison is `installStateFor`'s, so the chip and the row badge can
    // never disagree about what has an update waiting.
    const installed = index([
      installedPlugin({ pluginId: "history", version: "0.9.0" }),
      installedPlugin({ pluginId: "graph", version: "1.0.0" }),
    ]);
    expect(queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, state: "updates" }, installed)
      .map((entry) => entry.pluginId)).toEqual(["history"]);
  });

  it("keeps nothing under the installed or updates states when no index is supplied", () => {
    // The default matters: a caller that forgets the index must show an empty
    // list rather than silently showing the whole catalogue as installed.
    expect(queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, state: "installed" })).toEqual([]);
    expect(queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, state: "updates" })).toEqual([]);
  });

  it("scopes the surface facets to the state filter", () => {
    const facets = deriveSurfaceFacets(
      catalogue,
      { ...DEFAULT_MARKETPLACE_QUERY, state: "installed" },
      index([installedPlugin({ pluginId: "graph" })]),
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
    expect(byInstalls.map((entry) => entry.pluginId)).toEqual(["history", "graph", "beacon"]);

    const byStars = queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, sort: "stars" });
    expect(byStars[0]?.pluginId).toBe("graph");
    expect(byStars.slice(1).map((entry) => entry.displayName)).toEqual(["Beacon", "History"]);
  });

  it("sorts newest first and puts undated entries last", () => {
    const byNew = queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, sort: "new" });
    expect(byNew.map((entry) => entry.pluginId)[0]).toBe("beacon");
  });

  it("reverses ranked counts when sortDir is asc, and still puts unknown last", () => {
    const asc = queryMarketplace(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, sort: "installs", sortDir: "asc" });
    expect(asc.map((entry) => entry.pluginId)).toEqual(["beacon", "graph", "history"]);
  });

  it("counts facets against the other axes but not the facet selection", () => {
    const facets = deriveSurfaceFacets(catalogue, { ...DEFAULT_MARKETPLACE_QUERY, surfaces: ["lanes"] });
    expect(facets).toEqual([
      { surface: "work", label: "Work", total: 1 },
      { surface: "lanes", label: "Lanes", total: 1 },
    ]);
  });

  it("counts every type chip, including the ones at zero, and not against itself", () => {
    const typed = [
      listing({ pluginId: "acme", displayName: "Acme", kind: "integration" }),
      listing({ pluginId: "board", displayName: "Board", kind: "view" }),
      listing({ pluginId: "slate", displayName: "Slate", isTheme: true, kind: "theme" }),
    ];
    // Themes are excluded by the view, Tools is zero and still drawn, and
    // selecting Integrations does not zero the others.
    expect(deriveTypeFacets(typed, { ...DEFAULT_MARKETPLACE_QUERY, types: ["integration"] })).toEqual([
      { type: "integration", label: "Integrations", total: 1 },
      { type: "tool", label: "Tools", total: 0 },
      { type: "view", label: "Views", total: 1 },
    ]);
  });
});

describe("marketplaceFiltersActive", () => {
  it("does not count the view itself as a filter", () => {
    // The featured row hides behind this. Switching to Themes is not narrowing
    // a list; it is choosing which list.
    expect(marketplaceFiltersActive(DEFAULT_MARKETPLACE_QUERY)).toBe(false);
    expect(marketplaceFiltersActive({ ...DEFAULT_MARKETPLACE_QUERY, view: "themes" })).toBe(false);
    expect(marketplaceFiltersActive({ ...DEFAULT_MARKETPLACE_QUERY, types: ["tool"] })).toBe(true);
    expect(marketplaceFiltersActive({ ...DEFAULT_MARKETPLACE_QUERY, state: "installed" })).toBe(true);
    expect(marketplaceFiltersActive({ ...DEFAULT_MARKETPLACE_QUERY, surfaces: ["work"] })).toBe(true);
    expect(marketplaceFiltersActive({ ...DEFAULT_MARKETPLACE_QUERY, search: "  " })).toBe(false);
    expect(marketplaceFiltersActive({ ...DEFAULT_MARKETPLACE_QUERY, search: "graph" })).toBe(true);
  });
});

describe("normalizeMarketplaceQuery", () => {
  it("never restores the search box", () => {
    // A Marketplace that opens with last week's word in the box looks like a
    // Marketplace with three plugins in it.
    expect(normalizeMarketplaceQuery({ ...DEFAULT_MARKETPLACE_QUERY, search: "linear" }).search).toBe("");
  });

  it("drops values it does not recognise rather than keeping them", () => {
    expect(normalizeMarketplaceQuery({
      view: "everything",
      types: ["tool", "wat"],
      state: "starred",
      surfaces: ["work", "nowhere"],
      sort: "alphabetical",
      sortDir: "sideways",
    })).toEqual({
      search: "",
      view: "plugins",
      types: ["tool"],
      state: "all",
      surfaces: ["work"],
      sort: "installs",
      sortDir: "desc",
    });
  });

  it("reads a whole persisted query back", () => {
    const stored = {
      search: "ignored",
      view: "themes",
      types: ["integration", "view"],
      state: "updates",
      surfaces: ["lanes", "work"],
      sort: "new",
      sortDir: "asc",
    };
    expect(normalizeMarketplaceQuery(stored)).toEqual({
      search: "",
      view: "themes",
      types: ["integration", "view"],
      state: "updates",
      // Canonical surface order, not the stored order, so two saved queries
      // that mean the same thing compare equal.
      surfaces: ["work", "lanes"],
      sort: "new",
      sortDir: "asc",
    });
  });

  it("falls back to the whole default for anything that is not an object", () => {
    for (const value of [null, undefined, 7, "plugins", []]) {
      expect(normalizeMarketplaceQuery(value)).toEqual(DEFAULT_MARKETPLACE_QUERY);
    }
  });
});

describe("sameMarketplaceFilters", () => {
  it("ignores the search box and the order of a multi-select", () => {
    // This is the guard that keeps a re-render from writing to storage.
    expect(sameMarketplaceFilters(
      { ...DEFAULT_MARKETPLACE_QUERY, search: "a", types: ["tool", "view"], surfaces: ["work", "lanes"] },
      { ...DEFAULT_MARKETPLACE_QUERY, search: "b", types: ["view", "tool"], surfaces: ["lanes", "work"] },
    )).toBe(true);
    expect(sameMarketplaceFilters(
      DEFAULT_MARKETPLACE_QUERY,
      { ...DEFAULT_MARKETPLACE_QUERY, view: "themes" },
    )).toBe(false);
    expect(sameMarketplaceFilters(
      DEFAULT_MARKETPLACE_QUERY,
      { ...DEFAULT_MARKETPLACE_QUERY, types: ["tool"] },
    )).toBe(false);
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
      // And no download size: these ship inside the app, so there is nothing to
      // fetch and no number that would mean anything if there were.
      expect(describePluginDownload(entry).size).toBeNull();
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
    expect(queryMarketplace(merged.listings, { ...DEFAULT_MARKETPLACE_QUERY, view: "themes" }).length)
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
