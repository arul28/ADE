/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

import type { InstalledPlugin } from "../../lib/pluginRuntimeBridge";

/**
 * The registry hands back a fresh array on every poll, which is what makes the
 * theme half of this hook subtle: it re-runs constantly, and applying a theme
 * ends any running preview. The Marketplace's preview is deliberately sticky —
 * it exists so you can walk off to another tab and look — so a poll that
 * reverted it would break the feature from a distance, with nothing on screen
 * connecting cause to effect.
 */

const registry = {
  plugins: [] as InstalledPlugin[],
  themeId: null as string | null,
};

vi.mock("../../state/appStore", () => ({
  rootAppStoreApi: { getState: () => ({ refreshInstalledPlugins: async () => {} }) },
  useRootAppStore: (select: (state: unknown) => unknown) =>
    select({ installedPlugins: registry.plugins, pluginThemeId: registry.themeId }),
}));

vi.mock("../../lib/pluginRuntimeBridge", () => ({
  subscribeToPluginChanges: () => () => {},
}));

const { usePluginRegistrySync } = await import("./usePluginRegistry");
const {
  isPreviewingPluginTheme,
  previewPluginTheme,
  resetPluginThemeEngine,
} = await import("../../lib/pluginTheme");

function plugin(): InstalledPlugin {
  return {
    pluginId: "slate",
    displayName: "Slate",
    version: "1.0.0",
    enabled: true,
    icon: null,
    accent: null,
    theme: { displayName: "Slate", tokens: { dark: { "--color-bg": "#101014" } } },
    disabledContributions: [],
  } as unknown as InstalledPlugin;
}

beforeEach(() => {
  resetPluginThemeEngine();
  registry.plugins = [plugin()];
  registry.themeId = "slate";
});

afterEach(() => {
  cleanup();
  resetPluginThemeEngine();
});

describe("usePluginRegistrySync", () => {
  it("leaves a running preview alone when a refresh changes nothing", () => {
    const { rerender } = renderHook(() => usePluginRegistrySync());

    previewPluginTheme({
      pluginId: "aurora",
      displayName: "Aurora",
      tokens: { dark: { "--color-bg": "#001018" } },
    });
    expect(isPreviewingPluginTheme()).toBe(true);

    // A poll: same facts, brand new array.
    registry.plugins = [plugin()];
    rerender();

    expect(isPreviewingPluginTheme()).toBe(true);
  });

  it("ends the preview when the applied theme actually changes", () => {
    const { rerender } = renderHook(() => usePluginRegistrySync());

    previewPluginTheme({
      pluginId: "aurora",
      displayName: "Aurora",
      tokens: { dark: { "--color-bg": "#001018" } },
    });
    expect(isPreviewingPluginTheme()).toBe(true);

    registry.themeId = null;
    rerender();

    expect(isPreviewingPluginTheme()).toBe(false);
  });
});
