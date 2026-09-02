import { describe, expect, it } from "vitest";

import { persistableSurfaceRoute, splitRouteQuery } from "./App";
import { supersededCompiledRouteReplacement, type BuiltinGateInput } from "../plugins/builtinTabs";
import type { InstalledPlugin } from "../../lib/pluginRuntimeBridge";

/**
 * A superseded compiled route keeps its query across the hop to the plugin tab.
 *
 * `#/graph?focusLane=<id>` is not decoration: it is how the PRs tab and the
 * lane stack pane ask the workspace canvas to focus one lane, and the canvas
 * reads it back out of the URL. Once `ade-graph` is installed that URL is
 * answered by `/plugin/ade-graph`, and a redirect that carried only the path
 * dropped the lane — the reader pressed "View in graph" and got the graph with
 * nothing selected.
 *
 * The gate itself is registered under the bare path, so the two halves have to
 * be separated before either is asked about. That is `splitRouteQuery`, and
 * both the route-storage writer and the routed redirect run through it.
 */

const GRAPH_PLUGIN: InstalledPlugin = {
  pluginId: "ade-graph",
  displayName: "Graph",
  version: "1.0.0",
  enabled: true,
  icon: "graph",
  accent: "#7C6FF0",
  status: "none",
  tabs: [{ id: "graph", title: "Graph", panelId: "graph" }],
  theme: null,
};

function gate(overrides: Partial<BuiltinGateInput> = {}): BuiltinGateInput {
  return { pluginSupport: true, pluginsLoaded: true, plugins: [], ...overrides };
}

describe("splitRouteQuery", () => {
  it("keeps a bare route whole", () => {
    expect(splitRouteQuery("/graph")).toEqual({ path: "/graph", suffix: "" });
  });

  it("cuts at the query", () => {
    expect(splitRouteQuery("/graph?focusLane=lane-7")).toEqual({
      path: "/graph",
      suffix: "?focusLane=lane-7",
    });
  });

  it("cuts at a hash with no query", () => {
    expect(splitRouteQuery("/files#L20")).toEqual({ path: "/files", suffix: "#L20" });
  });

  it("keeps a hash that follows a query", () => {
    expect(splitRouteQuery("/graph?focusLane=lane-7#node")).toEqual({
      path: "/graph",
      suffix: "?focusLane=lane-7#node",
    });
  });
});

describe("a stored route that the owner plugin now answers", () => {
  it("moves to the plugin tab with the query intact", () => {
    expect(persistableSurfaceRoute("/graph?focusLane=lane-7", gate({ plugins: [GRAPH_PLUGIN] })))
      .toBe("/plugin/ade-graph?focusLane=lane-7");
  });

  it("stays on the compiled route while the owner is not installed", () => {
    expect(persistableSurfaceRoute("/graph?focusLane=lane-7", gate()))
      .toBe("/graph?focusLane=lane-7");
  });

  it("leaves an ungated route and its query alone", () => {
    expect(persistableSurfaceRoute("/files?externalPath=/tmp/a", gate({ plugins: [GRAPH_PLUGIN] })))
      .toBe("/files?externalPath=/tmp/a");
  });

  /**
   * The path-only lookup is what made this necessary: the replacement helper
   * matches an owner by exact route, so a route carrying a query found no
   * owner at all and every caller silently treated it as one of ADE's own.
   */
  it("is why the path is split first", () => {
    expect(supersededCompiledRouteReplacement("/graph?focusLane=lane-7", gate({ plugins: [GRAPH_PLUGIN] })))
      .toBeNull();
    expect(supersededCompiledRouteReplacement("/graph", gate({ plugins: [GRAPH_PLUGIN] })))
      .toBe("/plugin/ade-graph");
  });
});
