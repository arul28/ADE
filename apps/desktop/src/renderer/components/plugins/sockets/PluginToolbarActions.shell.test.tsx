/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

/**
 * The window top bar's copy of the toolbar socket: draggable chrome, and the
 * plugin's own mark.
 *
 * Two defects met here and they had the same cause — the cluster was mounted as
 * if the header were an ordinary toolbar. The header is a DRAG region, so a
 * child that does not opt out swallows the press and moves the window instead
 * of invoking anything; and the header's controls are 20px shell buttons, so
 * the generic 28px socket pill sat among them as a taller box with a second
 * hairline. The third was next to them: `brand:linear` is a token ade-linear
 * SHIPS, so it resolves only from the plugin's own glyph rows, and without them
 * ADE's compiled catalogue answered with the puzzle piece.
 */

/** Linear's real mark, as the host sanitizes it into `ade.brandIcons`. */
const LINEAR_GLYPH = {
  viewBox: "0 0 100 100",
  paths: [{ d: "M1 1h10v10H1z" }],
};

function installHost(): void {
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
      getManifest: async () => ({
        name: "ade-linear",
        version: "1.0.0",
        sockets: [{
          socket: "toolbar-action",
          surface: "app",
          id: "top-bar-issues",
          label: "Linear",
          icon: "brand:linear",
          actionId: "openIssuesQuickView",
        }],
      }),
      listContributions: async () => [],
      onChanged: () => () => {},
      invoke: async () => ({}),
    },
  };
}

/**
 * The registry the brand rows come off, which is a DIFFERENT read from the
 * socket sources: the manifest names the token, the installed record carries
 * the sanitized artwork.
 */
function seedRegistry(brandIcons: unknown): void {
  const store = (rootAppStoreApi as unknown as {
    setState: (patch: Record<string, unknown>) => void;
  });
  store.setState({
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
}

let rootAppStoreApi: unknown;

async function loadComponent() {
  vi.resetModules();
  const bridge = await import("../../../lib/pluginRuntimeBridge");
  bridge.resetPluginBridgeAvailability();
  rootAppStoreApi = (await import("../../../state/appStore")).rootAppStoreApi;
  return (await import("./PluginToolbarActions")).PluginToolbarActions;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("the toolbar cluster inside the window's drag region", () => {
  it("opts out of the drag region, so the button is pressable at all", async () => {
    installHost();
    const PluginToolbarActions = await loadComponent();
    seedRegistry(null);

    const { container } = render(
      <PluginToolbarActions
        surface="app"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      />,
    );
    await settle();

    // The wrapper, not the button: the drag region is inherited, so the opt-out
    // has to be on the element that sits inside the header.
    const cluster = container.firstElementChild as HTMLElement;
    // jsdom has no `-webkit-app-region` in its CSS property table, so React's
    // assignment lands on the declaration object rather than in `cssText`.
    // Reading it back there is still the real assertion: the value the renderer
    // handed the element is exactly what Electron reads.
    expect((cluster.style as unknown as Record<string, unknown>).WebkitAppRegion)
      .toBe("no-drag");
  });

  it("wears the header's own control chrome rather than the socket pill", async () => {
    installHost();
    const PluginToolbarActions = await loadComponent();
    seedRegistry(null);

    render(<PluginToolbarActions surface="app" chrome="shell" />);
    await settle();

    const button = screen.getByTitle("Linear");
    // The same class `LinearQuickViewButton` and every other header control
    // wears, which is where the height, radius, border and hover states live.
    expect(button.className).toContain("ade-shell-control");
    expect(button.className).toContain("h-[20px]");
    // No second box drawn on top of it — the double edge was the visible bug.
    expect(button.style.border).toBe("");
    expect(button.style.borderRadius).toBe("");
    expect(button.style.background).toBe("");
  });

  it("keeps the generic pill everywhere that is not the header", async () => {
    installHost();
    const PluginToolbarActions = await loadComponent();
    seedRegistry(null);

    render(<PluginToolbarActions surface="app" />);
    await settle();

    const button = screen.getByTitle("Linear");
    expect(button.className).toBe("");
    expect(button.style.height).toBe("28px");
  });
});

describe("a brand token the plugin itself shipped", () => {
  it("draws the plugin's own mark, not the puzzle piece", async () => {
    installHost();
    const PluginToolbarActions = await loadComponent();
    seedRegistry({ linear: LINEAR_GLYPH });

    render(<PluginToolbarActions surface="app" />);
    await settle();

    const svg = screen.getByTitle("Linear").querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe(LINEAR_GLYPH.viewBox);
    expect(svg?.querySelector("path")?.getAttribute("d")).toBe(LINEAR_GLYPH.paths[0]!.d);
  });

  it("falls back to the puzzle piece when the plugin ships no rows", async () => {
    // Not a regression — it is the honest answer for a token nothing can
    // resolve, and it is what makes the assertion above mean something.
    installHost();
    const PluginToolbarActions = await loadComponent();
    seedRegistry(null);

    render(<PluginToolbarActions surface="app" />);
    await settle();

    const svg = screen.getByTitle("Linear").querySelector("svg");
    expect(svg?.getAttribute("viewBox")).not.toBe(LINEAR_GLYPH.viewBox);
  });
});
