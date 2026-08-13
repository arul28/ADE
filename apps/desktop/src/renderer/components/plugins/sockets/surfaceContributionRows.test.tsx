/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { PluginToolbarActions } from "./PluginToolbarActions";
import type { PluginEntityKind, PluginSurfaceId } from "../../../../shared/plugins/sockets";

/**
 * The surface-scoped read, end to end through a real socket component.
 *
 * `contributionModel.test.ts` proves the selection rule as a pure function.
 * What that cannot prove is the half that actually broke: the per-surface READ
 * asked only for the entity kind its surface carries, so a row published
 * against the tab was fetched by nobody however correct the selector was. This
 * asserts the request, because a passing selector over rows that were never
 * loaded is exactly the shape of the original bug.
 */

const requested: { surface: PluginSurfaceId; entityKind?: PluginEntityKind }[] = [];

beforeAll(() => {
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
      // No manifest sockets at all: everything this plugin contributes arrives
      // as published rows, which is the shape a plugin reaching the phone has.
      getManifest: async () => ({ name: "graph", version: "1.0.0", sockets: [] }),
      listContributions: async (input: { surface: PluginSurfaceId; entityKind?: PluginEntityKind }) => {
        requested.push({ surface: input.surface, entityKind: input.entityKind });
        if (input.entityKind !== "surface") return [];
        return [
          {
            entityKind: "surface",
            entityId: input.surface,
            pluginId: "graph",
            socket: "toolbar-action",
            socketId: "sync",
            surface: input.surface,
            payload: { label: "Sync graph", actionId: "sync" },
            updatedAt: "2026-08-13T00:00:00.000Z",
          },
        ];
      },
      invoke: async () => ({}),
      onChanged: () => () => {},
    },
  };
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("surface-scoped rows reach a desktop surface", () => {
  it("asks for the surface's own entity kind AND `surface`, and renders the row", async () => {
    render(<PluginToolbarActions surface="lanes" />);

    // The contribution the plugin published against the tab is on screen. It
    // was fetched by nobody before this fix.
    await waitFor(() => expect(screen.getByText("Sync graph")).toBeTruthy());

    const forLanes = requested.filter((entry) => entry.surface === "lanes");
    expect(forLanes.map((entry) => entry.entityKind).sort()).toEqual(["lane", "surface"]);
  });

  it("asks once on a surface that has no entity kind of its own", async () => {
    // `cto`, `app` and `settings` already ARE `surface`. Asking twice would
    // fetch the same rows twice and render every contribution doubled.
    render(<PluginToolbarActions surface="cto" />);

    await waitFor(() => expect(screen.getAllByText("Sync graph")).toHaveLength(1));

    const forCto = requested.filter((entry) => entry.surface === "cto");
    expect(forCto.map((entry) => entry.entityKind)).toEqual(["surface"]);
  });
});
