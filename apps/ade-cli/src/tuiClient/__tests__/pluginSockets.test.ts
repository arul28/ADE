import { describe, expect, it, vi } from "vitest";
import type { PluginContributionRecord, PluginSummary } from "../../../../desktop/src/shared/plugins/sdk";
import type { AdeCodeConnection } from "../types";
import { invokePluginAction } from "../adeApi";
import {
  buildPluginActionsPane,
  buildPluginTuiContributions,
  fitPluginBadgeStrip,
  pluginBadgeStripText,
  pluginContributionRows,
  pluginRowActionEntries,
  pluginRowBadgeStrip,
  pluginSocketSources,
  pluginSocketSupportedInTui,
  tuiLaneContext,
  tuiSessionContext,
} from "../pluginSockets";

function summary(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    pluginId: "graph",
    version: "1.0.0",
    displayName: "Graph",
    description: "",
    icon: null,
    accent: null,
    enabled: true,
    status: "running",
    warnings: [],
    errors: [],
    source: { kind: "directory", path: "/plugins/graph" },
    installedAt: "2026-08-01T00:00:00.000Z",
    hasEntry: true,
    surfaces: [],
    ...overrides,
  } as PluginSummary;
}

const GRAPH_MANIFEST = {
  sockets: [
    { socket: "row-badge", surface: "lanes", id: "lane-badge", label: "risk" },
    { socket: "row-menu-item", surface: "lanes", id: "lane-audit", label: "Audit lane", actionId: "auditLane" },
    { socket: "toolbar-action", surface: "lanes", id: "lane-sweep", label: "Sweep lanes", actionId: "sweep" },
    { socket: "row-badge", surface: "work", id: "chat-badge", label: "cost" },
  ],
};

function laneBadgeRecord(overrides: Partial<PluginContributionRecord> = {}): PluginContributionRecord {
  return {
    entityKind: "lane",
    entityId: "lane-1",
    pluginId: "graph",
    socket: "row-badge",
    surface: "lanes",
    socketId: "lane-badge",
    payload: { text: "risk 8", tone: "warning", tooltip: "Touches the release path" },
    updatedAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

const LANE = { id: "lane-1", name: "plugin-platform", branchRef: "refs/heads/plugin-platform", status: { dirty: true } };

function contributionsFor(
  plugins: PluginSummary[],
  records: { lanes?: PluginContributionRecord[]; work?: PluginContributionRecord[] } = {},
) {
  const manifests = new Map<string, unknown>(plugins.map((plugin) => [plugin.pluginId, GRAPH_MANIFEST]));
  return buildPluginTuiContributions(pluginSocketSources(plugins, manifests), {
    lanes: pluginContributionRows(records.lanes ?? []),
    work: pluginContributionRows(records.work ?? []),
  });
}

describe("TUI socket support", () => {
  it("draws only the three kinds this client has an honest home for", () => {
    expect(pluginSocketSupportedInTui("row-badge")).toBe(true);
    expect(pluginSocketSupportedInTui("row-menu-item")).toBe(true);
    expect(pluginSocketSupportedInTui("toolbar-action")).toBe(true);
    for (const kind of ["detail-section", "empty-state", "filter-chip", "file-viewer", "composer-action"] as const) {
      expect(pluginSocketSupportedInTui(kind)).toBe(false);
    }
  });
});

describe("row badges", () => {
  it("renders a published badge row with its own text and tone", () => {
    const set = contributionsFor([summary()], { lanes: [laneBadgeRecord()] });
    const strip = pluginRowBadgeStrip(set.lanes, tuiLaneContext(LANE));

    expect(strip.cells).toHaveLength(1);
    expect(strip.cells[0]?.text).toBe("risk 8");
    expect(strip.cells[0]?.tone).toBe("warning");
    expect(pluginBadgeStripText(strip)).toBe("[risk 8]");
  });

  it("draws nothing for a declared badge and everything for a published one", () => {
    const set = contributionsFor([summary()], { lanes: [laneBadgeRecord()] });
    const withRow = pluginRowBadgeStrip(set.lanes, tuiLaneContext(LANE));
    // Another lane has no published row. The manifest declaration reserves the
    // slot and says nothing about THIS lane, so the row stays unmarked rather
    // than wearing the plugin's manifest label as a placeholder.
    const withoutRow = pluginRowBadgeStrip(set.lanes, tuiLaneContext({ ...LANE, id: "lane-2" }));

    expect(withRow.cells.map((cell) => cell.text)).toEqual(["risk 8"]);
    expect(withoutRow.cells).toEqual([]);
    expect(pluginBadgeStripText(withoutRow)).toBe("");
  });

  it("keeps the declaration itself, so a published row still matches it", () => {
    // The rule is about drawing, not about parsing: the manifest socket is
    // still in the set (it is what a published row is matched against and what
    // the install disclosure describes), and only the badge kind is silent.
    const set = contributionsFor([summary()]);

    expect(set.lanes.staticContributions.map((entry) => entry.id).sort())
      .toEqual(["lane-audit", "lane-badge", "lane-sweep"]);
    // …and the other declared sockets are untouched by this rule.
    expect(pluginRowActionEntries(set.lanes, "lanes", tuiLaneContext(LANE)).map((entry) => entry.actionId))
      .toEqual(["auditLane"]);
  });

  it("gives a published badge the visible slot a declaration used to take", () => {
    // Two declarations, one published row for this lane. Only two badges are
    // visible on a row, so a placeholder that survived selection could push the
    // plugin's real answer into the overflow count.
    const manifest = {
      sockets: [
        { socket: "row-badge", surface: "lanes", id: "a", label: "aaa" },
        { socket: "row-badge", surface: "lanes", id: "b", label: "bbb" },
        { socket: "row-badge", surface: "lanes", id: "c", label: "ccc" },
      ],
    };
    const set = buildPluginTuiContributions(
      pluginSocketSources([summary()], new Map([["graph", manifest]])),
      {
        lanes: pluginContributionRows([laneBadgeRecord({ socketId: "c", payload: { text: "risk 8", tone: "warning" } })]),
        work: [],
      },
    );
    const strip = pluginRowBadgeStrip(set.lanes, tuiLaneContext(LANE));

    expect(strip.cells.map((cell) => cell.text)).toEqual(["risk 8"]);
    expect(strip.overflowCount).toBe(0);
  });

  it("drops every contribution when the plugin is disabled", () => {
    const set = contributionsFor([summary({ enabled: false })], { lanes: [laneBadgeRecord()] });

    expect(pluginRowBadgeStrip(set.lanes, tuiLaneContext(LANE)).cells).toEqual([]);
    expect(pluginRowActionEntries(set.lanes, "lanes", tuiLaneContext(LANE))).toEqual([]);
  });

  it("drops a badge whose manifest socket the user switched off", () => {
    const set = contributionsFor(
      [summary({ disabledContributions: ["lane-badge"] })],
      { lanes: [laneBadgeRecord()] },
    );

    expect(pluginRowBadgeStrip(set.lanes, tuiLaneContext(LANE)).cells).toEqual([]);
  });

  it("keeps a session badge to its own surface", () => {
    const set = contributionsFor([summary()], {
      work: [laneBadgeRecord({
        entityKind: "session",
        entityId: "chat-1",
        surface: "work",
        socketId: "chat-badge",
        payload: { text: "$1.20", tone: "neutral" },
      })],
    });

    const chat = pluginRowBadgeStrip(set.work, tuiSessionContext({ sessionId: "chat-1", title: "Refactor" }));
    expect(pluginBadgeStripText(chat)).toBe("[$1.20]");
    // The lanes set was built from no rows at all, so the lane row stays bare —
    // it never borrows the chat's published value, and the lanes declaration is
    // not a stand-in for one.
    expect(pluginBadgeStripText(pluginRowBadgeStrip(set.lanes, tuiLaneContext(LANE)))).toBe("");
  });
});

describe("badge width fitting", () => {
  const strip = {
    cells: [
      { key: "a", pluginId: "graph", text: "risk 8", tone: "warning" as const, tooltip: null },
      { key: "b", pluginId: "graph", text: "stale", tone: "neutral" as const, tooltip: null },
    ],
    overflowCount: 1,
  };

  it("keeps everything when the row has room", () => {
    expect(pluginBadgeStripText(fitPluginBadgeStrip(strip, 40))).toBe("[risk 8] [stale] +1");
  });

  it("moves badges into the overflow count until the rest fit", () => {
    // "[risk 8]" (8) + " +2" (3) = 11.
    expect(pluginBadgeStripText(fitPluginBadgeStrip(strip, 11))).toBe("[risk 8] +2");
  });

  it("renders nothing rather than a bare overflow count", () => {
    expect(fitPluginBadgeStrip(strip, 3).cells).toEqual([]);
    expect(pluginBadgeStripText(fitPluginBadgeStrip(strip, 3))).toBe("");
  });
});

describe("the plugin actions pane", () => {
  it("lists row menu items for the focused lane and the surface's toolbar actions", () => {
    const set = contributionsFor([summary()]);
    const pane = buildPluginActionsPane({
      set: set.lanes,
      surface: "lanes",
      context: tuiLaneContext(LANE),
      entityLabel: "plugin-platform",
      surfaceLabel: "Lanes",
      width: 60,
    });

    expect(pane.rows).toEqual([
      "plugin-platform",
      "▸ Audit lane · Graph",
      "",
      "Lanes",
      "▸ Sweep lanes · Graph",
    ]);
    // Heading and spacer rows are not activatable.
    expect(pane.ids[0]).toBe("");
    expect(pane.ids[2]).toBe("");
    expect(pane.ids[3]).toBe("");
    expect(pane.entriesByKey.get(pane.ids[1]!)).toMatchObject({
      pluginId: "graph",
      actionId: "auditLane",
      socket: "row-menu-item",
    });
    expect(pane.entriesByKey.get(pane.ids[4]!)).toMatchObject({
      actionId: "sweep",
      socket: "toolbar-action",
    });
  });

  it("keeps the plugin's name on a narrow pane and shortens its label instead", () => {
    const set = contributionsFor([summary({ displayName: "Graph" })]);
    const pane = buildPluginActionsPane({
      set: set.lanes,
      surface: "lanes",
      context: tuiLaneContext(LANE),
      entityLabel: "plugin-platform",
      surfaceLabel: "Lanes",
      width: 18,
    });

    // A row that has lost its attribution reads as one of ADE's own.
    for (const row of pane.rows.filter((entry) => entry.startsWith("▸"))) {
      expect(row).toContain("· Graph");
      expect(row.length).toBeLessThanOrEqual(18);
    }
  });

  it("is empty for a plugin that contributes nothing here", () => {
    const set = buildPluginTuiContributions(
      pluginSocketSources([summary()], new Map([["graph", { sockets: [] }]])),
      { lanes: [], work: [] },
    );
    const pane = buildPluginActionsPane({
      set: set.lanes,
      surface: "lanes",
      context: tuiLaneContext(LANE),
      entityLabel: "plugin-platform",
      surfaceLabel: "Lanes",
      width: 60,
    });

    expect(pane.rows).toEqual([]);
    expect(pane.entriesByKey.size).toBe(0);
  });

  it("invokes the plugin with the row's typed context", async () => {
    const calls: Array<{ domain: string; action: string; args: Record<string, unknown> | undefined }> = [];
    const connection = {
      action: async (domain: string, action: string, args?: Record<string, unknown>) => {
        calls.push({ domain, action, args });
        return { navigate: { panelId: "audit" } };
      },
    } as unknown as AdeCodeConnection;

    const set = contributionsFor([summary()]);
    const context = tuiLaneContext(LANE);
    const pane = buildPluginActionsPane({
      set: set.lanes,
      surface: "lanes",
      context,
      entityLabel: "plugin-platform",
      surfaceLabel: "Lanes",
      width: 60,
    });
    const entry = pane.entriesByKey.get(pane.ids[1]!)!;
    const result = await invokePluginAction(connection, entry.pluginId, entry.actionId, { context });

    expect(calls).toEqual([{
      domain: "plugin",
      action: "invoke",
      args: {
        pluginId: "graph",
        action: "auditLane",
        args: {
          context: {
            kind: "lane",
            id: "lane-1",
            name: "plugin-platform",
            branch: "plugin-platform",
            machineKey: null,
            dirty: true,
          },
        },
      },
    }]);
    expect(result).toEqual({ navigate: { panelId: "audit" } });
  });

  it("surfaces a rejected invoke instead of swallowing it", async () => {
    const connection = {
      action: vi.fn().mockRejectedValue(new Error("plugin handler threw")),
    } as unknown as AdeCodeConnection;

    await expect(invokePluginAction(connection, "graph", "auditLane", {}))
      .rejects.toThrow("plugin handler threw");
  });
});
