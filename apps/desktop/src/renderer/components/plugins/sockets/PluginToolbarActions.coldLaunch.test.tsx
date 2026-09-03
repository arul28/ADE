/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

/**
 * The manifest read latch, which cost the top bar its plugin buttons on every
 * cold launch.
 *
 * The plugin host lives in the ade-cli daemon, and the top bar mounts before
 * that domain binds. `plugins.list` was already retried correctly — the sources
 * store keeps a failed load stale — but the MANIFEST read beside it was not:
 * `readPluginManifest` swallowed the refusal to null, `cachedManifest` banked
 * that null for the session, and `loadPluginSocketSources` reported the load as
 * a SUCCESS carrying a plugin with no manifest. Every static socket is declared
 * in a manifest, so the model then answered `[]` for all of them, the store
 * cleared `stale`, and the Linear top-bar button did not appear until the app
 * was relaunched.
 *
 * This is the whole chain end to end: the real bridge, the real cache, the real
 * store, and the real component. A test that mocked the loader would have
 * passed against every one of those four bugs.
 */

type ChangeListener = (event: { kind: string }) => void;

/** The typed refusal a host with no plugin runtime bound answers with. */
function unavailable(): Error {
  const error = new Error("plugins_unavailable: no plugin host on this machine yet");
  (error as unknown as { code: string }).code = "plugins_unavailable";
  return error;
}

/** ade-linear's real top-bar declaration, verbatim from its `plugin.json`. */
function linearManifest() {
  return {
    name: "ade-linear",
    version: "1.0.0",
    sockets: [
      {
        socket: "toolbar-action",
        surface: "app",
        id: "top-bar-issues",
        label: "Linear",
        icon: "brand:linear",
        actionId: "openIssuesQuickView",
      },
    ],
  };
}

function installHost(getManifest: () => Promise<unknown>): void {
  (window as unknown as { ade?: unknown }).ade = {
    plugins: {
      // Steady throughout: the list is NOT the failing read here. Isolating the
      // manifest is the point — the list's own retry was already fixed, and a
      // test that failed both could not tell which repair it was proving.
      list: async () => [{
        pluginId: "ade-linear",
        displayName: "Linear",
        enabled: true,
        accent: null,
        icon: "brand:linear",
        disabledContributions: [],
      }],
      getManifest,
      listContributions: async () => [],
      onChanged: (_listener: ChangeListener) => () => {},
      invoke: async () => ({}),
    },
  };
}

/**
 * A FRESH module graph, because the caches under test are module-level: the
 * manifest cache, the sources store, and the runtime bridge's availability
 * latch would otherwise carry one test's answer into the next.
 */
async function loadComponent() {
  vi.resetModules();
  const bridge = await import("../../../lib/pluginRuntimeBridge");
  bridge.resetPluginBridgeAvailability();
  return (await import("./PluginToolbarActions")).PluginToolbarActions;
}

/**
 * Flush the store's promise chain AND the render it schedules.
 *
 * The repair under test is a loop between the two: a failed load settles the
 * store, the surface re-renders, and that render's effect asks again. React
 * only runs a passive effect inside `act`, so a bare `await` would observe the
 * first refusal and nothing after it — the test would fail against the fixed
 * code and pass against nothing.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
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

describe("a toolbar action whose manifest read refused once", () => {
  it("draws the button after the retry, without a relaunch", async () => {
    let calls = 0;
    installHost(async () => {
      calls += 1;
      if (calls === 1) throw unavailable();
      return linearManifest();
    });
    const PluginToolbarActions = await loadComponent();

    render(<PluginToolbarActions surface="app" />);
    await settle();

    // The first read refused, the store stayed stale, the surface asked again,
    // and the real declaration arrived — with no relaunch anywhere in that.
    expect(screen.getByTitle("Linear")).toBeTruthy();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("falls through to plugins.get when getManifest refuses outright", async () => {
    // The other half of the repair: a host whose `getManifest` always refuses
    // still has the manifest on the detail record, and reading it there is the
    // difference between a working top bar and an empty one.
    installHost(async () => {
      throw unavailable();
    });
    (window as unknown as { ade: { plugins: Record<string, unknown> } })
      .ade.plugins.get = async () => ({ manifest: linearManifest() });
    const PluginToolbarActions = await loadComponent();

    render(<PluginToolbarActions surface="app" />);
    await settle();

    expect(screen.getByTitle("Linear")).toBeTruthy();
  });

  it("keeps asking rather than banking a null manifest as 'declares nothing'", async () => {
    let calls = 0;
    installHost(async () => {
      calls += 1;
      return calls <= 2 ? null : linearManifest();
    });
    const PluginToolbarActions = await loadComponent();

    render(<PluginToolbarActions surface="app" />);
    await settle();

    expect(screen.getByTitle("Linear")).toBeTruthy();
    expect(calls).toBeGreaterThan(2);
  });
});
