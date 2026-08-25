/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

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
  /** What the store's `refreshInstalledPlugins` says about each attempt. */
  loaded: true,
  /** What the store COMMITTED: false while no trusted answer has landed. */
  pluginsLoaded: true,
  refreshes: 0,
};

/**
 * The store action, standing in for the real one's contract: it resolves false
 * when the load failed and left the registry untouched, true when an answer —
 * including a genuine empty — was committed.
 */
const refreshInstalledPlugins = async (): Promise<boolean> => {
  registry.refreshes += 1;
  if (!registry.loaded) return false;
  registry.pluginsLoaded = true;
  return true;
};

let changeListener: ((event: { kind: string }) => void) | null = null;

vi.mock("../../state/appStore", () => ({
  rootAppStoreApi: { getState: () => ({ refreshInstalledPlugins }) },
  useRootAppStore: (select: (state: unknown) => unknown) =>
    select({
      installedPlugins: registry.plugins,
      pluginsLoaded: registry.pluginsLoaded,
      pluginThemeId: registry.themeId,
    }),
}));

vi.mock("../../lib/pluginRuntimeBridge", () => ({
  subscribeToPluginChanges: (listener: (event: { kind: string }) => void) => {
    changeListener = listener;
    return () => {
      changeListener = null;
    };
  },
}));

const {
  PLUGIN_REGISTRY_RETRY_BASE_MS,
  PLUGIN_REGISTRY_RETRY_MAX_MS,
  pluginRegistryRetryDelayMs,
  usePluginAutomationSteps,
  usePluginAutomationTriggers,
  usePluginRegistrySync,
} = await import("./usePluginRegistry");
const {
  appliedPluginTheme,
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
  registry.loaded = true;
  registry.pluginsLoaded = true;
  registry.refreshes = 0;
  changeListener = null;
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
 * The bootstrap bug this hook was rebuilt around.
 *
 * A load that failed or raced the plugin host used to commit as an empty
 * registry, which every reader then took as fact: the Marketplace's "Installed"
 * filter showed 0 with four plugins installed, and the user's plugin theme
 * repainted with the built-in palette. Nothing retried — the count and the
 * theme both only came back when an unrelated install event forced the next
 * fetch. Both symptoms are one rule: an empty registry that has not answered
 * means "not known", never "none installed".
 */
describe("usePluginRegistrySync bootstrap", () => {
  it("keeps the applied theme while the registry has no trusted answer", async () => {
    const { rerender } = renderHook(() => usePluginRegistrySync());
    await act(async () => {});
    expect(appliedPluginTheme()?.pluginId).toBe("slate");

    // What a failed load leaves behind: an empty array and no trusted answer.
    registry.plugins = [];
    registry.pluginsLoaded = false;
    rerender();

    expect(appliedPluginTheme()?.pluginId).toBe("slate");
  });

  it("clears the theme once the registry confirms the plugin is really gone", async () => {
    const { rerender } = renderHook(() => usePluginRegistrySync());
    await act(async () => {});
    expect(appliedPluginTheme()?.pluginId).toBe("slate");

    // Same empty array, but this time it is an answer: the plugin was removed.
    registry.plugins = [];
    registry.pluginsLoaded = true;
    rerender();

    expect(appliedPluginTheme()).toBeNull();
  });

  it("retries a failed load on a backoff and applies the theme once it lands", async () => {
    vi.useFakeTimers();
    try {
      // Boot against a host whose plugin host is not bound yet.
      registry.loaded = false;
      registry.pluginsLoaded = false;
      registry.plugins = [];
      const { rerender } = renderHook(() => usePluginRegistrySync());
      await act(async () => {});
      expect(registry.refreshes).toBe(1);
      expect(appliedPluginTheme()).toBeNull();

      // Nothing fires before the first delay is up.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PLUGIN_REGISTRY_RETRY_BASE_MS - 1);
      });
      expect(registry.refreshes).toBe(1);

      // The host binds, and the retry finds the four plugins that were there
      // all along.
      registry.loaded = true;
      registry.plugins = [plugin()];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(registry.refreshes).toBe(2);

      rerender();
      expect(appliedPluginTheme()?.pluginId).toBe("slate");

      // Landed means landed: no timer is still running behind it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PLUGIN_REGISTRY_RETRY_MAX_MS * 4);
      });
      expect(registry.refreshes).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles on a genuine empty registry without retrying", async () => {
    vi.useFakeTimers();
    try {
      registry.plugins = [];
      registry.themeId = null;
      renderHook(() => usePluginRegistrySync());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PLUGIN_REGISTRY_RETRY_MAX_MS * 4);
      });

      expect(registry.refreshes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off further on each failure, up to the ceiling", () => {
    expect(pluginRegistryRetryDelayMs(1)).toBe(PLUGIN_REGISTRY_RETRY_BASE_MS);
    expect(pluginRegistryRetryDelayMs(2)).toBe(PLUGIN_REGISTRY_RETRY_BASE_MS * 2);
    expect(pluginRegistryRetryDelayMs(99)).toBe(PLUGIN_REGISTRY_RETRY_MAX_MS);
  });

  it("still refreshes on an install or status change, and does so at once", async () => {
    vi.useFakeTimers();
    try {
      registry.loaded = false;
      registry.pluginsLoaded = false;
      registry.plugins = [];
      renderHook(() => usePluginRegistrySync());
      await act(async () => {});
      expect(registry.refreshes).toBe(1);

      // A panel write is the panel host's business, not the registry's.
      await act(async () => {
        changeListener?.({ kind: "panels" });
      });
      expect(registry.refreshes).toBe(1);

      // An install lands mid-backoff: it loads NOW rather than queueing behind
      // the pending retry, and the retry it replaces does not fire on top of it.
      registry.loaded = true;
      registry.plugins = [plugin()];
      await act(async () => {
        changeListener?.({ kind: "installs" });
      });
      expect(registry.refreshes).toBe(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PLUGIN_REGISTRY_RETRY_MAX_MS * 4);
      });
      expect(registry.refreshes).toBe(2);
    } finally {
      vi.useRealTimers();
    }
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
