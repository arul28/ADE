import { describe, expect, it } from "vitest";

import {
  PLUGIN_GRAPH_NODES_PER_PLUGIN_LIMIT,
  parsePluginContributionPayload,
  type PluginEntityContribution,
} from "../../../shared/plugins/sockets";
import type {
  PluginSocketIdentity,
  SurfaceContributionSet,
} from "../plugins/sockets/contributionModel";
import { entityCacheKey } from "../plugins/sockets/contributionModel";
import {
  buildPluginGraphOverlay,
  describePluginGraphOverflow,
  isPluginGraphNodeId,
  pluginGraphNodeId,
} from "./pluginGraphNodes";

/**
 * The overlay builder, on its own.
 *
 * Everything asserted here is a rule the canvas cannot express and a rendering
 * test cannot pin: which anchors resolve, which edges survive, and what a cap
 * drops. Layout is deliberately absent — the builder decides nothing about
 * coordinates, which is why the page can move a node without breaking any of
 * this.
 */

const IDENTITY: PluginSocketIdentity = {
  pluginId: "tracker",
  displayName: "Tracker",
  accent: "#7C6FF0",
  icon: "kanban",
};

function row(overrides: {
  pluginId?: string;
  entityKind?: PluginEntityContribution["entityKind"];
  entityId: string;
  payload: Record<string, unknown>;
  order?: number;
  id?: string;
}): PluginEntityContribution {
  const socket = "graph-node" as const;
  // Through the real parser, never a hand-built payload: a test that asserted
  // rendering over a shape the writer would have refused proves nothing.
  const payload = parsePluginContributionPayload(socket, overrides.payload);
  if (!payload) throw new Error(`fixture payload is invalid: ${JSON.stringify(overrides.payload)}`);
  return {
    pluginId: overrides.pluginId ?? IDENTITY.pluginId,
    socket,
    surface: "lanes",
    id: overrides.id ?? "issue",
    ...(overrides.order === undefined ? {} : { order: overrides.order }),
    payload,
    entityKind: overrides.entityKind ?? "lane",
    entityId: overrides.entityId,
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

function setOf(
  rows: readonly PluginEntityContribution[],
  identities: readonly PluginSocketIdentity[] = [IDENTITY],
): SurfaceContributionSet {
  const dynamicByEntity = new Map<string, PluginEntityContribution[]>();
  for (const entry of rows) {
    const key = entityCacheKey(entry.entityKind, entry.entityId);
    const existing = dynamicByEntity.get(key);
    if (existing) existing.push(entry);
    else dynamicByEntity.set(key, [entry]);
  }
  return {
    surface: "lanes",
    staticContributions: [],
    dynamicByEntity,
    identities: new Map(identities.map((identity) => [identity.pluginId, identity])),
    filterKeysByEntity: new Map(),
  };
}

const LANES = new Set(["lane-a", "lane-b"]);
const NO_PRS = new Map<string, string>();

describe("anchoring", () => {
  it("hangs a lane-published node off that lane", () => {
    const overlay = buildPluginGraphOverlay({
      set: setOf([row({ entityId: "lane-a", payload: { label: "ADE-1" } })]),
      laneNodeIds: LANES,
      laneNodeIdByPrId: NO_PRS,
    });
    expect(overlay.entries).toHaveLength(1);
    expect(overlay.entries[0]!.anchorNodeId).toBe("lane-a");
    expect(overlay.entries[0]!.nodeId).toBe(pluginGraphNodeId("tracker", "lane", "lane-a"));
    expect(isPluginGraphNodeId(overlay.entries[0]!.nodeId)).toBe(true);
  });

  it("floats a surface-published node with no anchor", () => {
    const overlay = buildPluginGraphOverlay({
      set: setOf([row({ entityKind: "surface", entityId: "lanes", payload: { label: "Sprint 12" } })]),
      laneNodeIds: LANES,
      laneNodeIdByPrId: NO_PRS,
    });
    expect(overlay.entries).toHaveLength(1);
    expect(overlay.entries[0]!.anchorNodeId).toBeNull();
  });

  it("drops a node whose lane is not on the canvas", () => {
    // Collapsed, filtered out, or deleted on another machine — all the same to
    // the canvas. A node hanging from nothing is worse than no node.
    const overlay = buildPluginGraphOverlay({
      set: setOf([row({ entityId: "lane-gone", payload: { label: "ADE-1" } })]),
      laneNodeIds: LANES,
      laneNodeIdByPrId: NO_PRS,
    });
    expect(overlay.entries).toEqual([]);
    // Not counted as a cap refusal: nothing was withheld for want of room.
    expect(overlay.droppedCount).toBe(0);
  });

  it("drops a row from a plugin that is no longer installed", () => {
    const overlay = buildPluginGraphOverlay({
      set: setOf([row({ pluginId: "ghost", entityId: "lane-a", payload: { label: "ADE-1" } })], []),
      laneNodeIds: LANES,
      laneNodeIdByPrId: NO_PRS,
    });
    expect(overlay.entries).toEqual([]);
  });
});

describe("core nodes are untouchable", () => {
  it("never claims an id the canvas already draws", () => {
    // The whole "a plugin cannot displace a lane" guarantee, asserted without
    // reference to any position: the page APPENDS these to a finished node list,
    // so the only way a plugin could cost the canvas a lane node is by producing
    // one of its ids. Namespacing is what makes that impossible, whatever a
    // plugin publishes against.
    const overlay = buildPluginGraphOverlay({
      set: setOf([
        row({ entityId: "lane-a", payload: { label: "A" } }),
        row({ entityKind: "surface", entityId: "lanes", payload: { label: "B" } }),
      ]),
      laneNodeIds: LANES,
      laneNodeIdByPrId: NO_PRS,
    });
    expect(overlay.entries).toHaveLength(2);
    for (const entry of overlay.entries) {
      expect(LANES.has(entry.nodeId)).toBe(false);
      expect(isPluginGraphNodeId(entry.nodeId)).toBe(true);
    }
    // And every edge lands on a node the canvas is already drawing, so a plugin
    // cannot create a lane by pointing at one.
    for (const entry of overlay.entries) {
      for (const edge of entry.edges) expect(LANES.has(edge.toNodeId)).toBe(true);
    }
  });

  it("gives two plugins annotating one lane two distinct nodes", () => {
    const second = { ...IDENTITY, pluginId: "deploys", displayName: "Deploys" };
    const overlay = buildPluginGraphOverlay({
      set: setOf(
        [
          row({ entityId: "lane-a", payload: { label: "A" } }),
          row({ pluginId: "deploys", entityId: "lane-a", payload: { label: "B" } }),
        ],
        [IDENTITY, second],
      ),
      laneNodeIds: LANES,
      laneNodeIdByPrId: NO_PRS,
    });
    const ids = overlay.entries.map((entry) => entry.nodeId);
    expect(new Set(ids).size).toBe(2);
    expect(overlay.entries.every((entry) => entry.anchorNodeId === "lane-a")).toBe(true);
  });
});

describe("edges", () => {
  it("resolves a lane target and a PR target to canvas nodes", () => {
    const overlay = buildPluginGraphOverlay({
      set: setOf([row({
        entityId: "lane-a",
        payload: {
          label: "ADE-1",
          edges: [
            { to: { kind: "lane", id: "lane-b" }, kind: "tracks" },
            { to: { kind: "pr", id: "42" }, kind: "blocks", label: "waits" },
          ],
        },
      })]),
      laneNodeIds: LANES,
      // A PR is an overlay ON a lane card, so an edge at a PR lands on its lane.
      laneNodeIdByPrId: new Map([["42", "lane-b"]]),
    });
    expect(overlay.entries[0]!.edges).toEqual([
      { toNodeId: "lane-b", kind: "tracks" },
      { toNodeId: "lane-b", kind: "blocks", label: "waits" },
    ]);
  });

  it("drops an unresolvable target and keeps the node", () => {
    const overlay = buildPluginGraphOverlay({
      set: setOf([row({
        entityId: "lane-a",
        payload: {
          label: "ADE-1",
          edges: [{ to: { kind: "lane", id: "lane-gone" }, kind: "link" }],
        },
      })]),
      laneNodeIds: LANES,
      laneNodeIdByPrId: NO_PRS,
    });
    expect(overlay.entries).toHaveLength(1);
    expect(overlay.entries[0]!.edges).toEqual([]);
  });

  it("does not draw a second line over the anchor's own", () => {
    const overlay = buildPluginGraphOverlay({
      set: setOf([row({
        entityId: "lane-a",
        payload: { label: "ADE-1", edges: [{ to: { kind: "lane", id: "lane-a" }, kind: "link" }] },
      })]),
      laneNodeIds: LANES,
      laneNodeIdByPrId: NO_PRS,
    });
    expect(overlay.entries[0]!.edges).toEqual([]);
  });
});

describe("caps", () => {
  const manyLanes = new Set(Array.from({ length: 60 }, (_, index) => `lane-${index}`));
  const manyRows = (pluginId: string, count: number): PluginEntityContribution[] =>
    Array.from({ length: count }, (_, index) => row({
      pluginId,
      entityId: `lane-${index}`,
      payload: { label: `${pluginId}-${index}` },
    }));

  it("refuses one plugin's surplus past the per-plugin cap", () => {
    const overlay = buildPluginGraphOverlay({
      set: setOf(manyRows("tracker", PLUGIN_GRAPH_NODES_PER_PLUGIN_LIMIT + 3)),
      laneNodeIds: manyLanes,
      laneNodeIdByPrId: NO_PRS,
    });
    expect(overlay.entries).toHaveLength(PLUGIN_GRAPH_NODES_PER_PLUGIN_LIMIT);
    expect(overlay.droppedCount).toBe(3);
    expect(overlay.droppedPluginIds).toEqual(["tracker"]);
  });

  it("refuses the collective surplus past the total cap", () => {
    // Two well-behaved plugins, each inside its own allowance, together over the
    // total. This is the failure no per-plugin number can prevent.
    const second: PluginSocketIdentity = { ...IDENTITY, pluginId: "deploys", displayName: "Deploys" };
    const overlay = buildPluginGraphOverlay({
      set: setOf(
        [...manyRows("tracker", 20), ...manyRows("deploys", 20)],
        [IDENTITY, second],
      ),
      laneNodeIds: manyLanes,
      laneNodeIdByPrId: NO_PRS,
      totalLimit: 30,
    });
    expect(overlay.entries).toHaveLength(30);
    expect(overlay.droppedCount).toBe(10);
  });

  it("says what it withheld, and says nothing when it withheld nothing", () => {
    const dropped = buildPluginGraphOverlay({
      set: setOf(manyRows("tracker", 5)),
      laneNodeIds: manyLanes,
      laneNodeIdByPrId: NO_PRS,
      perPluginLimit: 2,
    });
    expect(describePluginGraphOverflow(dropped)).toBe(
      "3 plugin nodes hidden to keep the graph readable (tracker)",
    );
    expect(describePluginGraphOverflow({ entries: [], droppedCount: 0, droppedPluginIds: [] })).toBe("");
  });

  it("keeps the same nodes whatever order the rows arrive in", () => {
    // Two machines hold the same rows in different Map order. A cap that kept
    // whichever arrived first would show a different graph on each.
    const rows = [
      row({ entityId: "lane-0", order: 3, id: "c", payload: { label: "C" } }),
      row({ entityId: "lane-1", order: 1, id: "a", payload: { label: "A" } }),
      row({ entityId: "lane-2", order: 2, id: "b", payload: { label: "B" } }),
    ];
    const kept = (input: PluginEntityContribution[]): string[] =>
      buildPluginGraphOverlay({
        set: setOf(input),
        laneNodeIds: manyLanes,
        laneNodeIdByPrId: NO_PRS,
        perPluginLimit: 2,
      }).entries.map((entry) => entry.payload.label);

    expect(kept(rows)).toEqual(["A", "B"]);
    expect(kept([...rows].reverse())).toEqual(["A", "B"]);
  });
});
