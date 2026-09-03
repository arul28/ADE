/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

/**
 * The audit behind `usePluginBrandIcons`: every socket that draws an icon draws
 * the PLUGIN'S icon.
 *
 * ADE compiles five vendor marks in, and a `brand:*` token outside that closed
 * set can only ever resolve from the artwork the package shipped. So a renderer
 * that does not pass the plugin's glyph rows shows the puzzle piece for exactly
 * the plugins that took the trouble to ship a mark — and that is what every
 * socket except the settings section was doing.
 *
 * One file for all of them on purpose. The failure was not one component's bug;
 * it was six components each independently forgetting the same argument, and a
 * per-component test would let the seventh forget it too. The row-menu and
 * badge cases go through their real adapters rather than a component, because
 * that is where those sockets' icons are actually resolved.
 *
 * Three sockets are deliberately absent and are not gaps: `command-palette-action`
 * rows carry no icon field at all (see `PluginPaletteCommand`), `filter-chip`
 * draws the generic mark by design, and `empty-state` renders its button
 * without an icon.
 */

/** A plugin-shipped mark, in the shape the host sanitizes it into. */
const GLYPH = { viewBox: "0 0 24 24", paths: [{ d: "M2 2h6v6H2z" }] };

type Socket = Record<string, unknown>;

/** A lane the badges hang off. Row badges are per-entity, never per surface. */
const LANE_CONTEXT = {
  kind: "lane" as const,
  id: "lane-1",
  name: "Feature",
  branch: "feature",
  machineKey: null,
  dirty: false,
};

const BADGE_ROW = {
  entityKind: "lane",
  entityId: "lane-1",
  pluginId: "ade-linear",
  socket: "row-badge",
  socketId: "linked",
  surface: "lanes",
  payload: { text: "ADE-1", tone: "neutral", icon: "brand:linear" },
  updatedAt: "2026-09-02T00:00:00.000Z",
};

function installHost(sockets: Socket[], rows: unknown[] = []): void {
  (window as unknown as { ade?: unknown }).ade = {
    plugins: {
      list: async () => [{
        pluginId: "ade-linear",
        displayName: "Linear",
        enabled: true,
        accent: null,
        icon: "brand:linear",
        disabledContributions: [],
      }],
      getManifest: async () => ({ name: "ade-linear", version: "1.0.0", sockets }),
      // Scoped to the row's own entity kind. The store asks once per kind a
      // surface carries, and answering every ask with the same row would draw
      // the badge twice — a fixture artefact, not the socket's behaviour.
      listContributions: async (args: { entityKind?: string }) => (
        rows.filter((row) => (row as { entityKind?: string }).entityKind === args.entityKind)
      ),
      onChanged: () => () => {},
      invoke: async () => ({}),
    },
  };
}

let seedRegistry: (brandIcons: unknown) => void;

/** A fresh module graph per test — the socket caches are module-level. */
async function loadSockets() {
  vi.resetModules();
  const bridge = await import("../../../lib/pluginRuntimeBridge");
  bridge.resetPluginBridgeAvailability();
  const { rootAppStoreApi } = await import("../../../state/appStore");
  seedRegistry = (brandIcons: unknown) => {
    (rootAppStoreApi as unknown as { setState: (patch: Record<string, unknown>) => void })
      .setState({
        installedPlugins: [{
          pluginId: "ade-linear",
          displayName: "Linear",
          enabled: true,
          version: "1.0.0",
          icon: "brand:linear",
          accent: null,
          source: "registry",
          disabledContributions: [],
          ...(brandIcons ? { brandIcons } : {}),
        }],
      });
  };
  return import("./index");
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** True when this element drew the plugin's own mark rather than a fallback. */
function drewPluginMark(host: Element | null | undefined): boolean {
  const svg = host?.querySelector("svg");
  return svg?.getAttribute("viewBox") === GLYPH.viewBox
    && svg?.querySelector("path")?.getAttribute("d") === GLYPH.paths[0]!.d;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("brand glyphs across the socket renderers", () => {
  it("draws the plugin's mark on a chat-header action", async () => {
    installHost([{
      socket: "chat-header-action",
      surface: "work",
      id: "issue",
      label: "Issue",
      icon: "brand:linear",
      actionId: "openIssue",
    }]);
    const { PluginChatHeaderActions } = await loadSockets();
    seedRegistry({ linear: GLYPH });

    render(
      <PluginChatHeaderActions
        surface="work"
        session={{ kind: "session", id: "s1", title: "Chat", provider: null, status: null }}
      />,
    );
    await settle();

    expect(drewPluginMark(screen.getByText("Issue").closest("button"))).toBe(true);
  });

  it("draws the plugin's mark on a composer action", async () => {
    installHost([{
      socket: "composer-action",
      surface: "work",
      id: "attach",
      label: "Attach",
      icon: "brand:linear",
      actionId: "attachIssue",
    }]);
    const { PluginComposerActions } = await loadSockets();
    seedRegistry({ linear: GLYPH });

    render(
      <PluginComposerActions
        surface="work"
        sessionId="s1"
        readDraft={() => ({ draft: "", cursor: null })}
      />,
    );
    await settle();

    expect(drewPluginMark(screen.getByText("Attach").closest("button"))).toBe(true);
  });

  it("draws the plugin's mark on a row badge", async () => {
    installHost([], [BADGE_ROW]);
    const { PluginRowBadges } = await loadSockets();
    seedRegistry({ linear: GLYPH });

    render(<PluginRowBadges surface="lanes" context={LANE_CONTEXT} />);
    await settle();

    expect(drewPluginMark(screen.getByTitle("ADE-1"))).toBe(true);
  });

  it("carries the plugin's rows onto a row-menu entry", async () => {
    // The row menus draw their icon in the adapter, from the entry, so this is
    // where the rows have to arrive — the four menus that call it pass nothing.
    const { pluginContextMenuItems } = await loadSockets();

    const items = pluginContextMenuItems([{
      kind: "action",
      key: "k",
      label: "Open in Linear",
      icon: "brand:linear",
      pluginId: "ade-linear",
      brandIcons: { linear: GLYPH },
      onSelect: () => {},
    }]);

    const row = items.find((item) => item.type === "item");
    const { container } = render(<>{(row as { icon: React.ReactNode }).icon}</>);
    expect(drewPluginMark(container)).toBe(true);
  });

  it("is the shared hook everywhere, so a plugin with no rows still resolves", async () => {
    // The negative half. A plugin that ships no artwork must keep drawing the
    // compiled catalogue's answer rather than nothing at all, which is what
    // makes every assertion above a statement about the ROWS.
    installHost([], [BADGE_ROW]);
    const { PluginRowBadges } = await loadSockets();
    seedRegistry(null);

    render(<PluginRowBadges surface="lanes" context={LANE_CONTEXT} />);
    await settle();

    const badge = screen.getByTitle("ADE-1");
    expect(badge?.querySelector("svg")).toBeTruthy();
    expect(drewPluginMark(badge)).toBe(false);
  });
});
