/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * A plugin's tab badge, through the REAL socket layer.
 *
 * `TabNav.test.tsx` mocks `usePluginTabBadges` wholesale, which is right for
 * asking how the rail DRAWS a pill and useless for asking whether one ever
 * arrives. Everything between a published row and the rail is unasserted there:
 * which surface the tab is, how the badge is addressed, and the gate filter
 * that used to run before the badges were resolved at all.
 *
 * So this file mocks nothing below the host. It publishes a `row-badge` row the
 * way a plugin does — against `"<pluginId>/<tabSurfaceId>"` on the `app`
 * surface — and reads the rail.
 *
 * The fixture is a SUPERSEDES plugin, because every extracted plugin is one:
 * they replace a compiled tab rather than gating one, so they keep a rail entry
 * of their own and must be able to badge it. A gated plugin whose entry point
 * IS the compiled tab is covered too, by hanging its pill on that item.
 *
 * The stores behind the socket layer are module-level by design — a row must
 * never fetch — so each test takes a fresh module graph, and everything that
 * touches state is imported from the same fresh graph.
 */

const GRAPH_PLUGIN = {
  pluginId: "ade-graph",
  displayName: "Graph",
  version: "1.0.0",
  enabled: true,
  icon: "graph",
  accent: "#7C6FF0",
  status: "none" as const,
  // `graph` is the rail surface a badge is addressed against. No `builtin`
  // field: a plugin that supersedes may not declare one.
  tabs: [{ id: "graph", title: "Graph", panelId: "graph-panel" }],
  theme: null,
};

const GRAPH_MANIFEST = {
  name: "ade-graph",
  version: "1.0.0",
  displayName: "Graph",
  description: "The lane canvas.",
  vocabVersion: 1,
  surfaces: [{ kind: "tab", id: "graph", title: "Graph", panelId: "graph-panel" }],
  panels: [{ id: "graph-panel" }],
  sockets: [{ socket: "row-badge", surface: "app", id: "tab-badge", label: "Graph" }],
};

function badgeRow(entityId: string, text: string) {
  return {
    entityKind: "surface",
    entityId,
    pluginId: "ade-graph",
    socket: "row-badge",
    surface: "app",
    socketId: "tab-badge",
    payload: { text, tone: "accent" },
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

let contributionRows: unknown[] = [];

function installHost() {
  Object.defineProperty(globalThis.window, "ade", {
    configurable: true,
    writable: true,
    value: {
      app: {
        revealPath: async () => undefined,
        getInfo: async () => ({ isPackaged: false }),
        openExternal: vi.fn().mockResolvedValue(undefined),
      },
      plugins: {
        list: async () => [GRAPH_PLUGIN],
        getManifest: async () => GRAPH_MANIFEST,
        listContributions: async (args: { surface: string }) =>
          (args.surface === "app" ? contributionRows : []),
        getPanel: async () => null,
        getCollection: async () => [],
      },
    },
  });
}

/**
 * Render the rail against a fresh module graph.
 *
 * The socket layer's sources and rows live in module-level stores, so without
 * this the second test in the file would assert against the first one's answer.
 * The app store comes from the same fresh graph for the same reason — a seeded
 * registry has to reach the copy of the store `TabNav` actually reads.
 */
async function mountRail(entry = "/work") {
  vi.resetModules();
  const { TabNav } = await import("./TabNav");
  const { useAppStore, rootAppStoreApi } = await import("../../state/appStore");
  useAppStore.setState({
    project: { rootPath: "/repo", name: "Repo" },
    projectHydrated: true,
    showWelcome: false,
    smartTooltipsEnabled: true,
  } as never);
  rootAppStoreApi.setState({ installedPlugins: [GRAPH_PLUGIN], pluginsLoaded: true } as never);
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TabNav />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  contributionRows = [];
  window.localStorage.clear();
  installHost();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (globalThis.window as unknown as { ade?: unknown }).ade;
});

describe("a plugin tab's badge, end to end", () => {
  it("reaches the rail from a published row on the plugin's own surface", async () => {
    contributionRows = [badgeRow("ade-graph/graph", "4")];
    await mountRail();

    // The plugin SUPERSEDES the compiled Graph tab, so it keeps a rail entry of
    // its own — and that entry is what the pill belongs to. The gate filter
    // used to run before the badges were resolved, which made this unreachable.
    await waitFor(() => expect(screen.getByText("4")).toBeTruthy());
    expect(screen.getByRole("link", { name: "Graph, 4" })).toBeTruthy();
  });

  it("hides the pill while that tab is the one being read", async () => {
    contributionRows = [badgeRow("ade-graph/graph", "4")];
    await mountRail("/plugin/ade-graph");

    // A count on the tab you are looking at is a notification about the thing
    // in front of you. The row is untouched — it comes back on the next tab.
    await waitFor(() => expect(screen.getByRole("link", { name: "Graph" })).toBeTruthy());
    expect(screen.queryByText("4")).toBeNull();
  });

  it("clamps a long count to the pill rather than growing it over the icon", async () => {
    contributionRows = [badgeRow("ade-graph/graph", "1024 open")];
    await mountRail();

    // Six code points, no ellipsis — the same clamp the phone applies. The full
    // value stays in the accessible name, which is where the rest of it lives.
    await waitFor(() => expect(screen.getByText("1024 o")).toBeTruthy());
    expect(screen.getByRole("link", { name: "Graph, 1024 open" })).toBeTruthy();
  });

  it("ignores a row addressed to another plugin's tab", async () => {
    contributionRows = [badgeRow("ade-review/review", "9")];
    await mountRail();

    await waitFor(() => expect(screen.getByRole("link", { name: "Graph" })).toBeTruthy());
    expect(screen.queryByText("9")).toBeNull();
  });

  it("ignores a row whose address is not a plugin tab at all", async () => {
    // No slash is an ADE surface id; two slashes is not an address this
    // grammar can produce. Neither may be mistaken for this tab's.
    contributionRows = [badgeRow("app", "7"), badgeRow("ade-graph/graph/extra", "8")];
    await mountRail();

    await waitFor(() => expect(screen.getByRole("link", { name: "Graph" })).toBeTruthy());
    expect(screen.queryByText("7")).toBeNull();
    expect(screen.queryByText("8")).toBeNull();
  });
});
