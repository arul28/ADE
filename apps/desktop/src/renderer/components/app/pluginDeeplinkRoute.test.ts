import { describe, expect, it } from "vitest";

import type { BuiltinGateInput } from "../plugins/builtinTabs";
import { resolvePluginDeeplinkRouting } from "./pluginDeeplinkRoute";

function gateInput(overrides: Partial<BuiltinGateInput> = {}): BuiltinGateInput {
  return {
    pluginSupport: true,
    pluginsLoaded: true,
    plugins: [],
    ...overrides,
  };
}

function installed(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: "ade-graph",
    displayName: "Graph",
    version: "1.0.0",
    enabled: true,
    icon: null,
    accent: null,
    status: "running",
    tabs: [],
    theme: null,
    ...overrides,
  } as unknown as BuiltinGateInput["plugins"][number];
}

describe("resolvePluginDeeplinkRouting", () => {
  it("opens the panel route when the plugin is installed and enabled", () => {
    expect(
      resolvePluginDeeplinkRouting(
        { pluginId: "ade-graph", panelId: "overview" },
        gateInput({ plugins: [installed()] }),
      ),
    ).toEqual({ kind: "open", path: "/plugin/ade-graph?panel=overview" });
  });

  it("carries the context as a single-encoded ctx param", () => {
    const routing = resolvePluginDeeplinkRouting(
      { pluginId: "ade-graph", panelId: "overview", context: { issue: "ISS-14" } },
      gateInput({ plugins: [installed()] }),
    );
    expect(routing.kind).toBe("open");
    const search = new URL(
      routing.kind === "open" ? routing.path : "",
      "https://x.invalid",
    ).searchParams;
    expect(search.get("panel")).toBe("overview");
    expect(JSON.parse(search.get("ctx") ?? "null")).toEqual({ issue: "ISS-14" });
  });

  it("drops a context that will not serialize rather than failing the link", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      resolvePluginDeeplinkRouting(
        { pluginId: "ade-graph", panelId: "overview", context: cyclic },
        gateInput({ plugins: [installed()] }),
      ),
    ).toEqual({ kind: "open", path: "/plugin/ade-graph?panel=overview" });
  });

  it("refuses under the plugin's name when the registry knows it but it is off", () => {
    expect(
      resolvePluginDeeplinkRouting(
        { pluginId: "ade-graph", panelId: "overview" },
        gateInput({ plugins: [installed({ enabled: false })] }),
      ),
    ).toEqual({ kind: "refuse", title: "Graph" });
  });

  it("refuses under the plugin id when it is not installed", () => {
    expect(
      resolvePluginDeeplinkRouting({ pluginId: "ade-graph", panelId: "overview" }, gateInput()),
    ).toEqual({ kind: "refuse", title: "ade-graph" });
  });

  it("refuses while the registry is unresolved or the host has no plugins at all", () => {
    // Both are the hide-everything default: an unresolved registry must not
    // read as "installed", and it must not read differently from "absent".
    expect(
      resolvePluginDeeplinkRouting(
        { pluginId: "ade-graph", panelId: "overview" },
        gateInput({ pluginsLoaded: false, plugins: [installed()] }),
      ),
    ).toEqual({ kind: "refuse", title: "ade-graph" });
    expect(
      resolvePluginDeeplinkRouting(
        { pluginId: "ade-graph", panelId: "overview" },
        gateInput({ pluginSupport: false, plugins: [installed()] }),
      ),
    ).toEqual({ kind: "refuse", title: "ade-graph" });
  });
});
