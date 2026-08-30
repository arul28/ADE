/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import type { PluginLaneContext } from "../../../../shared/plugins/context";
import type * as PluginIcons from "../pluginIcons";
import { PluginRowBadges } from "./PluginRowBadges";
import { PluginToolbarActions } from "./PluginToolbarActions";

/**
 * The one promise this layer makes that a type system cannot: a contribution
 * that throws while rendering costs its own slot and nothing else.
 *
 * Third-party code renders inside first-party chrome here, on tabs that stay
 * mounted. Without containment the nearest catcher is the route's
 * `PageErrorBoundary`, so one bad badge blanks a tab of ADE's own content —
 * which is why this is asserted rather than assumed.
 */

vi.mock("../pluginIcons", async () => {
  const actual = await vi.importActual<typeof PluginIcons>("../pluginIcons");
  return {
    ...actual,
    pluginIcon: (name: string | null | undefined) => {
      if (name === "boom") {
        return function ThrowingIcon(): never {
          throw new Error("plugin icon exploded");
        };
      }
      return actual.pluginIcon(name);
    },
  };
});

const LANE_CONTEXT: PluginLaneContext = {
  kind: "lane",
  id: "lane-1",
  name: "Feature",
  branch: "feature",
  machineKey: null,
  dirty: false,
};

/** The whole tab's chrome, standing in for the route boundary above a surface. */
class SurfaceBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <div>tab crashed</div> : this.props.children;
  }
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  // React logs every caught render error; the boundary working is the point.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        {
          pluginId: "graph",
          displayName: "Graph",
          enabled: true,
          accent: null,
          icon: null,
          disabledContributions: [],
        },
      ],
      getManifest: async () => ({
        name: "graph",
        version: "1.0.0",
        sockets: [
          { socket: "row-badge", surface: "lanes", id: "first", label: "Ahead", order: 1 },
          { socket: "row-badge", surface: "lanes", id: "bad", label: "Broken", icon: "boom", order: 2 },
          { socket: "toolbar-action", surface: "lanes", id: "act-bad", label: "Break", actionId: "a", icon: "boom", order: 1 },
          { socket: "toolbar-action", surface: "lanes", id: "act-ok", label: "Sync", actionId: "b", order: 2 },
        ],
      }),
      // The badges are PUBLISHED, not merely declared: a declared badge
      // reserves its slot and draws nothing, so a test about what a badge does
      // while rendering needs a row filling it.
      // Answers for the lane entity kind only. A surface's rows are read once
      // per entity kind, so a mock that ignored the argument would hand the
      // same badge back twice and draw it twice.
      listContributions: async (input: { entityKind?: string }) => (input.entityKind !== "lane" ? [] : [
        {
          entityKind: "lane",
          entityId: "lane-1",
          pluginId: "graph",
          socket: "row-badge",
          socketId: "first",
          surface: "lanes",
          payload: { text: "Ahead", tone: "neutral", order: 1 },
          updatedAt: "2026-08-11T00:00:00.000Z",
        },
        {
          entityKind: "lane",
          entityId: "lane-1",
          pluginId: "graph",
          socket: "row-badge",
          socketId: "bad",
          surface: "lanes",
          payload: { text: "Broken", tone: "neutral", icon: "boom", order: 2 },
          updatedAt: "2026-08-11T00:00:00.000Z",
        },
      ]),
    },
  };
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  consoleError.mockRestore();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("a contribution that throws", () => {
  it("costs its own badge and leaves its siblings and the tab standing", async () => {
    render(
      <SurfaceBoundary>
        <div>lane row</div>
        <PluginRowBadges surface="lanes" context={LANE_CONTEXT} />
      </SurfaceBoundary>,
    );

    await waitFor(() => expect(screen.getByText("Ahead")).toBeTruthy());
    expect(screen.queryByText("Broken")).toBeNull();
    expect(screen.queryByText("tab crashed")).toBeNull();
    expect(screen.getByText("lane row")).toBeTruthy();
  });

  it("contains a throwing toolbar action the same way", async () => {
    render(
      <SurfaceBoundary>
        <PluginToolbarActions surface="lanes" />
      </SurfaceBoundary>,
    );

    await waitFor(() => expect(screen.getByText("Sync")).toBeTruthy());
    expect(screen.queryByText("Break")).toBeNull();
    expect(screen.queryByText("tab crashed")).toBeNull();
  });
});
