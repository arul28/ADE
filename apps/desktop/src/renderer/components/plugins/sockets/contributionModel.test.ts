import { describe, expect, it } from "vitest";

import { splitPluginRowBadges } from "../../../../shared/plugins/sockets";
import type { PluginLaneContext, PluginSurfaceContext } from "../../../../shared/plugins/context";
import { resolveViewerKind } from "../../files/v2/viewerRegistry";
import type { PluginContributionRow, PluginSocketSource } from "./contributionBridge";
import {
  buildContributionSet,
  buildPluginMenuEntries,
  contributionsFromSource,
  entityMatchesPluginFilters,
  matchPluginViewer,
  parsePluginViewerKind,
  pluginChangeAffects,
  pluginViewerKind,
  pluginViewerRegistrations,
  selectContributions,
} from "./contributionModel";

/**
 * The socket taxonomy's rules, tested as pure functions.
 *
 * Every assertion here is about a decision the product makes rather than about
 * markup: which contribution wins, what order they land in, what gets dropped.
 * Rendering is deliberately absent — a test that mounts a Lanes row to check a
 * badge breaks when the row's layout changes and proves nothing about the rule.
 */

function source(
  pluginId: string,
  sockets: unknown[],
  overrides: Partial<PluginSocketSource> = {},
): PluginSocketSource {
  return {
    pluginId,
    displayName: pluginId,
    enabled: true,
    accent: null,
    icon: null,
    disabledContributions: [],
    manifest: { name: pluginId, version: "1.0.0", sockets },
    ...overrides,
  };
}

const LANE_CONTEXT: PluginLaneContext = {
  kind: "lane",
  id: "lane-1",
  name: "Feature",
  branch: "feature",
  machineKey: null,
  dirty: false,
};

function laneBadgeRow(pluginId: string, payload: Record<string, unknown>): PluginContributionRow {
  return {
    entityKind: "lane",
    entityId: "lane-1",
    pluginId,
    socket: "row-badge",
    payload,
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

describe("manifest sockets → contributions", () => {
  it("translates each socket kind into its payload shape", () => {
    const contributions = contributionsFromSource(
      source("graph", [
        { socket: "toolbar-action", surface: "lanes", id: "sync", label: "Sync", actionId: "sync" },
        { socket: "row-menu-item", surface: "lanes", id: "open", label: "Open graph", actionId: "open" },
        { socket: "detail-section", surface: "lanes", id: "panel", label: "Graph", panelId: "main" },
        { socket: "filter-chip", surface: "lanes", id: "chip", label: "Stacked", filterKey: "stacked" },
      ]),
    );

    expect(contributions.map((entry) => entry.socket)).toEqual([
      "toolbar-action",
      "row-menu-item",
      "detail-section",
      "filter-chip",
    ]);
    expect(contributions[0]?.payload).toMatchObject({ label: "Sync", actionId: "sync" });
    expect(contributions[2]?.payload).toMatchObject({ panelId: "main", title: "Graph" });
  });

  it("drops a socket whose implied payload is incomplete", () => {
    // A toolbar action with no label would render as a nameless button.
    const contributions = contributionsFromSource(
      source("graph", [{ socket: "toolbar-action", surface: "lanes", id: "sync", actionId: "sync" }]),
    );
    expect(contributions).toEqual([]);
  });

  it("drops contributions the user switched off, and every socket of a disabled plugin", () => {
    const withDisabledSocket = contributionsFromSource(
      source(
        "graph",
        [
          { socket: "toolbar-action", surface: "lanes", id: "sync", label: "Sync", actionId: "sync" },
          { socket: "toolbar-action", surface: "lanes", id: "prune", label: "Prune", actionId: "prune" },
        ],
        { disabledContributions: ["prune"] },
      ),
    );
    expect(withDisabledSocket.map((entry) => entry.id)).toEqual(["sync"]);

    const disabledPlugin = contributionsFromSource(
      source("graph", [{ socket: "toolbar-action", surface: "lanes", id: "sync", label: "Sync", actionId: "sync" }], {
        enabled: false,
      }),
    );
    expect(disabledPlugin).toEqual([]);
  });
});

describe("static and dynamic merge", () => {
  it("lets a dynamic row replace the plugin's static badge for that entity", () => {
    const set = buildContributionSet(
      [source("graph", [{ socket: "row-badge", surface: "lanes", id: "state", label: "Graph" }])],
      [laneBadgeRow("graph", { text: "3 ahead", tone: "accent" })],
      "lanes",
    );

    const badges = selectContributions(set, "row-badge", LANE_CONTEXT);
    expect(badges).toHaveLength(1);
    expect(badges[0]?.payload.text).toBe("3 ahead");
  });

  it("keeps the static declaration for entities the plugin published nothing for", () => {
    const set = buildContributionSet(
      [source("graph", [{ socket: "row-badge", surface: "lanes", id: "state", label: "Graph" }])],
      [laneBadgeRow("graph", { text: "3 ahead", tone: "accent" })],
      "lanes",
    );

    const otherLane: PluginLaneContext = { ...LANE_CONTEXT, id: "lane-2" };
    const badges = selectContributions(set, "row-badge", otherLane);
    expect(badges.map((entry) => entry.payload.text)).toEqual(["Graph"]);
  });

  it("ignores rows from a plugin that is not installed", () => {
    const set = buildContributionSet([source("graph", [])], [laneBadgeRow("ghost", { text: "x", tone: "neutral" })], "lanes");
    expect(selectContributions(set, "row-badge", LANE_CONTEXT)).toEqual([]);
  });

  it("ignores rows whose payload does not match the socket", () => {
    const set = buildContributionSet(
      [source("graph", [])],
      [laneBadgeRow("graph", { tone: "accent" })],
      "lanes",
    );
    expect(selectContributions(set, "row-badge", LANE_CONTEXT)).toEqual([]);
  });

  it("keeps a surface's contributions out of the other five", () => {
    const set = buildContributionSet(
      [
        source("graph", [
          { socket: "toolbar-action", surface: "lanes", id: "a", label: "Lanes", actionId: "a" },
          { socket: "toolbar-action", surface: "prs", id: "b", label: "PRs", actionId: "b" },
        ]),
      ],
      [],
      "lanes",
    );
    expect(selectContributions(set, "toolbar-action").map((entry) => entry.payload.label)).toEqual(["Lanes"]);
  });
});

describe("ordering and caps", () => {
  it("sorts by order, then plugin id, then contribution id", () => {
    const set = buildContributionSet(
      [
        source("zeta", [{ socket: "toolbar-action", surface: "lanes", id: "a", label: "Z", actionId: "z" }]),
        source("alpha", [
          { socket: "toolbar-action", surface: "lanes", id: "b", label: "A2", actionId: "a2" },
          { socket: "toolbar-action", surface: "lanes", id: "a", label: "A1", actionId: "a1" },
          { socket: "toolbar-action", surface: "lanes", id: "first", label: "First", actionId: "f", order: 1 },
        ]),
      ],
      [],
      "lanes",
    );

    expect(selectContributions(set, "toolbar-action").map((entry) => entry.payload.label)).toEqual([
      "First",
      "A1",
      "A2",
      "Z",
    ]);
  });

  it("shows two badges and folds the rest into an overflow count", () => {
    const set = buildContributionSet(
      [
        source(
          "graph",
          [1, 2, 3, 4].map((index) => ({
            socket: "row-badge",
            surface: "lanes",
            id: `b${index}`,
            label: `B${index}`,
            order: index,
          })),
        ),
      ],
      [],
      "lanes",
    );

    const { visible, overflowCount } = splitPluginRowBadges(selectContributions(set, "row-badge", LANE_CONTEXT));
    expect(visible.map((entry) => entry.payload.text)).toEqual(["B1", "B2"]);
    expect(overflowCount).toBe(2);
  });

  it("caps how many contributions one plugin can put in a single slot", () => {
    const set = buildContributionSet(
      [
        source(
          "greedy",
          Array.from({ length: 12 }, (_, index) => ({
            socket: "toolbar-action",
            surface: "lanes",
            id: `a${index}`,
            label: `A${index}`,
            actionId: `a${index}`,
            order: index,
          })),
        ),
      ],
      [],
      "lanes",
    );
    expect(selectContributions(set, "toolbar-action")).toHaveLength(8);
  });
});

describe("menu entries", () => {
  const set = buildContributionSet(
    [
      source("graph", [
        { socket: "row-menu-item", surface: "lanes", id: "open", label: "Open graph", actionId: "graph.open" },
      ]),
    ],
    [],
    "lanes",
  );

  it("builds one entry per contribution, tagged for the tour", () => {
    const entries = buildPluginMenuEntries({
      set,
      surface: "lanes",
      context: LANE_CONTEXT,
      invoke: () => {},
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "action", label: "Open graph", dataTour: "plugin:lanes.row-menu-item" });
  });

  it("closes the menu, then invokes with the entity's typed context", () => {
    const calls: Array<[string, string, PluginSurfaceContext]> = [];
    const order: string[] = [];
    const entries = buildPluginMenuEntries({
      set,
      surface: "lanes",
      context: LANE_CONTEXT,
      invoke: (pluginId, actionId, context) => {
        order.push("invoke");
        calls.push([pluginId, actionId, context]);
      },
      onClose: () => order.push("close"),
    });

    entries[0]?.onSelect();
    expect(order).toEqual(["close", "invoke"]);
    expect(calls[0]).toEqual(["graph", "graph.open", LANE_CONTEXT]);
  });

  it("returns nothing for a surface with no contributed entries", () => {
    expect(
      buildPluginMenuEntries({ set, surface: "prs", context: LANE_CONTEXT, invoke: () => {} }),
    ).toEqual([]);
  });
});

describe("filter chips", () => {
  const set = buildContributionSet(
    [source("graph", [{ socket: "filter-chip", surface: "lanes", id: "c", label: "Stacked", filterKey: "stacked" }])],
    [laneBadgeRow("graph", { text: "3 ahead", tone: "accent", filterKey: "stacked" })],
    "lanes",
  );

  it("matches every entity when nothing is selected", () => {
    expect(entityMatchesPluginFilters(set, LANE_CONTEXT, [])).toBe(true);
    expect(entityMatchesPluginFilters(set, { ...LANE_CONTEXT, id: "lane-9" }, [])).toBe(true);
  });

  it("keeps only entities the plugin tagged with the selected key", () => {
    expect(entityMatchesPluginFilters(set, LANE_CONTEXT, ["stacked"])).toBe(true);
    expect(entityMatchesPluginFilters(set, { ...LANE_CONTEXT, id: "lane-9" }, ["stacked"])).toBe(false);
  });
});

describe("change-event routing", () => {
  it("refetches contributions when a plugin publishes them, and not the registry", () => {
    expect(pluginChangeAffects("contributions", "contributions")).toBe(true);
    expect(pluginChangeAffects("sources", "contributions")).toBe(false);
  });

  it("refetches both when what is installed changes", () => {
    // A new plugin may have rows waiting; a removed one's rows must stop.
    expect(pluginChangeAffects("sources", "installs")).toBe(true);
    expect(pluginChangeAffects("contributions", "installs")).toBe(true);
  });

  it("treats child-process health as a registry change only", () => {
    expect(pluginChangeAffects("sources", "status")).toBe(true);
    expect(pluginChangeAffects("contributions", "status")).toBe(false);
  });

  it("ignores panel and collection writes on both reads", () => {
    for (const kind of ["panels", "collections"]) {
      expect(pluginChangeAffects("sources", kind)).toBe(false);
      expect(pluginChangeAffects("contributions", kind)).toBe(false);
    }
  });

  it("refetches everything for a kind this build has never heard of", () => {
    // The daemon's kind list grows without a renderer release. A stale badge
    // with nothing to correct it is worse than one redundant round trip.
    expect(pluginChangeAffects("sources", "secrets")).toBe(true);
    expect(pluginChangeAffects("contributions", "secrets")).toBe(true);
    expect(pluginChangeAffects("contributions", "")).toBe(true);
  });
});

describe("file viewer resolution", () => {
  const viewers = pluginViewerRegistrations([
    source("player", [
      {
        socket: "file-viewer",
        surface: "files",
        id: "player",
        panelId: "play",
        extensions: [".fbx", ".GLB"],
      },
    ]),
  ]);

  it("registers the plugin's extensions, normalized", () => {
    expect(viewers).toEqual([
      { pluginId: "player", panelId: "play", displayName: "player", extensions: [".fbx", ".glb"] },
    ]);
  });

  it("claims a format no built-in viewer handles", () => {
    expect(resolveViewerKind({ path: "/scene.glb", pluginViewers: viewers })).toBe("plugin:player:play");
  });

  it("takes over the binary and large-text fallbacks", () => {
    expect(resolveViewerKind({ path: "/scene.fbx", isBinary: true, pluginViewers: viewers })).toBe("plugin:player:play");
    expect(resolveViewerKind({ path: "/scene.fbx", isPartial: true, pluginViewers: viewers })).toBe("plugin:player:play");
  });

  it("never takes a format a built-in viewer already owns", () => {
    const videoPlugin = pluginViewerRegistrations([
      source("player", [
        { socket: "file-viewer", surface: "files", id: "p", panelId: "play", extensions: [".mp4", ".md"] },
      ]),
    ]);
    expect(resolveViewerKind({ path: "/clip.mp4", pluginViewers: videoPlugin })).toBe("video");
    expect(resolveViewerKind({ path: "/readme.md", pluginViewers: videoPlugin })).toBe("markdown");
  });

  it("resolves normally when no plugin registers anything", () => {
    expect(resolveViewerKind({ path: "/scene.glb" })).toBe("code");
    expect(resolveViewerKind({ path: "/scene.glb", pluginViewers: [] })).toBe("code");
  });

  it("round-trips a viewer kind, and tolerates one whose plugin is gone", () => {
    const kind = pluginViewerKind("player", "play");
    expect(parsePluginViewerKind(kind)).toEqual({ pluginId: "player", panelId: "play" });
    // A persisted tab from an uninstalled plugin: still parses (so the host can
    // name it), but matches no registration, which is what sends the tab to the
    // binary fallback instead of a blank pane.
    expect(parsePluginViewerKind("plugin:ghost:panel")).toEqual({ pluginId: "ghost", panelId: "panel" });
    expect(matchPluginViewer(viewers, ".glb")?.pluginId).toBe("player");
    expect(matchPluginViewer(viewers, ".ghost")).toBeNull();
    expect(parsePluginViewerKind("code")).toBeNull();
    expect(parsePluginViewerKind("plugin:onlyone")).toBeNull();
  });

  it("matches an extension whether or not the caller included the dot", () => {
    expect(matchPluginViewer(viewers, "glb")?.panelId).toBe("play");
    expect(matchPluginViewer(viewers, ".GLB")?.panelId).toBe("play");
  });
});
