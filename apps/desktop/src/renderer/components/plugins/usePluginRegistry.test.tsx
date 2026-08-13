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

const {
  usePluginAutomationSteps,
  usePluginAutomationTriggers,
  usePluginRegistrySync,
} = await import("./usePluginRegistry");
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

/**
 * The rule builder's pickers. A declaration the user switched off must not be
 * offered — building a rule against it would arm the rule against nothing —
 * and the key is kind-qualified so a hidden socket cannot take a trigger with
 * it. See `shared/plugins/disabledContributions.ts`.
 */
describe("automation declarations offered to the rule builder", () => {
  const automating = (disabledContributions: string[]): InstalledPlugin => ({
    pluginId: "tracker",
    displayName: "Tracker",
    version: "1.0.0",
    enabled: true,
    icon: null,
    accent: null,
    theme: null,
    disabledContributions,
    automationTriggers: [
      { id: "issueMoved", label: "Issue moved" },
      { id: "issueClosed", label: "Issue closed" },
    ],
    automationSteps: [
      { id: "comment", label: "Comment", action: "postComment" },
      { id: "close", label: "Close", action: "closeIssue" },
    ],
  } as unknown as InstalledPlugin);

  it("offers every trigger and step a plugin declares", () => {
    registry.plugins = [automating([])];
    expect(renderHook(() => usePluginAutomationTriggers()).result.current.map((option) => option.value))
      .toEqual(["issueMoved", "issueClosed"]);
    expect(renderHook(() => usePluginAutomationSteps()).result.current.map((option) => option.value))
      .toEqual(["postComment", "closeIssue"]);
  });

  it("drops the ones the user switched off", () => {
    registry.plugins = [automating(["automationTrigger:issueClosed", "automationStep:close"])];
    expect(renderHook(() => usePluginAutomationTriggers()).result.current.map((option) => option.value))
      .toEqual(["issueMoved"]);
    expect(renderHook(() => usePluginAutomationSteps()).result.current.map((option) => option.value))
      .toEqual(["postComment"]);
  });

  it("keeps a declaration whose id merely matches a disabled socket", () => {
    registry.plugins = [automating(["issueClosed", "close"])];
    expect(renderHook(() => usePluginAutomationTriggers()).result.current).toHaveLength(2);
    expect(renderHook(() => usePluginAutomationSteps()).result.current).toHaveLength(2);
  });
});
